import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node';
import type { ChildProcess } from 'node:child_process';
import type { AceServerHandle, ExitHandler } from '../src/ace-server';
import type { DevEcoEnv } from '../src/env';

const hvigorMocks = vi.hoisted(() => ({
  parseHvigorSyncConfig: vi.fn(),
  runHvigorSyncAsync: vi.fn(),
}));

vi.mock('../src/hvigor', () => ({
  parseHvigorSyncConfig: hvigorMocks.parseHvigorSyncConfig,
  runHvigorSyncAsync: hvigorMocks.runHvigorSyncAsync,
}));

vi.mock('../src/ace-server', () => ({
  startAceServer: vi.fn(),
}));

import { createProxy, type ProxyHandle } from '../src/proxy';
import { startAceServer } from '../src/ace-server';

const mockedStartAceServer = vi.mocked(startAceServer);

function timeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)),
  ]);
}

function createFakeAceServer(): {
  handle: AceServerHandle;
  events: string[];
  notifications: Array<{ method: string; params: Record<string, unknown> }>;
  connection: MessageConnection;
};
function createFakeAceServer(options?: { hoverResult?: unknown }): {
  handle: AceServerHandle;
  events: string[];
  notifications: Array<{ method: string; params: Record<string, unknown> }>;
  connection: MessageConnection;
} {
  const aceStdout = new PassThrough();
  const aceStdin = new PassThrough();
  const exitHandlers: ExitHandler[] = [];
  const events: string[] = [];
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const proc = {
    stdout: aceStdout,
    stdin: aceStdin,
    stderr: new PassThrough(),
    on: vi.fn(),
    kill: vi.fn(),
    exitCode: null,
  } as unknown as ChildProcess;

  const connection = createMessageConnection(
    new StreamMessageReader(aceStdin),
    new StreamMessageWriter(aceStdout),
  );

  connection.onRequest((method) => {
    events.push(`request:${method}`);
    if (method === 'initialize') {
      return { capabilities: { hoverProvider: true } };
    }
    return null;
  });

  connection.onNotification((method, params) => {
    events.push(`notification:${method}`);
    notifications.push({ method, params: params as Record<string, unknown> });
    if (method === 'aceProject/onAsyncHover') {
      const requestId = typeof params?.requestId === 'string' ? params.requestId : '';
      queueMicrotask(() =>
        connection.sendNotification('aceProject/onAsyncHover', {
          requestId,
          result: options?.hoverResult ?? { contents: 'hover-ok' },
          traceId: 'aceProject/onAsyncHover',
        }),
      );
    }
    if (method === 'aceProject/onAsyncFindUsages') {
      const requestId = typeof params?.requestId === 'string' ? params.requestId : '';
      queueMicrotask(() =>
        connection.sendNotification('aceProject/onAsyncFindUsages', {
          requestId,
          result: [
            {
              uri: 'file:///tmp/project/entry/src/main/ets/pages/Index.ets',
              range: {
                start: { line: 1, character: 2 },
                end: { line: 1, character: 7 },
              },
            },
          ],
          traceId: 'aceProject/onAsyncFindUsages',
        }),
      );
    }
  });
  connection.listen();

  return {
    handle: {
      process: proc,
      kill: () => proc.kill(),
      onExit: (handler) => {
        exitHandlers.push(handler);
      },
      dispose: () => {
        connection.dispose();
        aceStdout.destroy();
        aceStdin.destroy();
        exitHandlers.length = 0;
      },
    },
    events,
    notifications,
    connection,
  };
}

function createClient(env: DevEcoEnv): {
  clientIn: PassThrough;
  clientOut: PassThrough;
  connection: MessageConnection;
  handle: ProxyHandle;
} {
  const clientIn = new PassThrough();
  const clientOut = new PassThrough();
  const handle = createProxy(clientIn, clientOut, env, {
    env,
    projectRootHint: path.resolve('test/fixtures/sample-project'),
  });
  const connection = createMessageConnection(
    new StreamMessageReader(clientOut),
    new StreamMessageWriter(clientIn),
  );
  connection.listen();
  return { clientIn, clientOut, connection, handle };
}

function createEnv(): DevEcoEnv {
  return {
    devecoHome: '/fake/deveco',
    sdkPath: '/fake/sdk',
    aceServerPath: '/fake/ace-server.js',
    nodeBin: process.execPath,
    hvigorPath: '/fake/hvigorw.js',
  };
}

describe('createProxy modern mode', () => {
  let proxyHandle: ProxyHandle | null = null;
  let clientConnection: MessageConnection | null = null;
  let aceConnection: MessageConnection | null = null;

  beforeEach(() => {
    hvigorMocks.parseHvigorSyncConfig.mockReturnValue({
      mode: 'auto',
      timeoutMs: 15_000,
      metadataMaxAgeMs: 24 * 60 * 60 * 1000,
    });
    hvigorMocks.runHvigorSyncAsync.mockResolvedValue({
      status: 'skipped',
      reason: 'fresh',
      metadataBefore: {
        state: 'fresh',
        dependencyMapPath: '/fake/project/.hvigor/dependencyMap/dependencyMap.json5',
      },
      elapsedMs: 0,
    });
  });

  afterEach(() => {
    clientConnection?.dispose();
    proxyHandle?.dispose();
    aceConnection?.dispose();
    clientConnection = null;
    proxyHandle = null;
    aceConnection = null;
    vi.clearAllMocks();
  });

  it('does not block hover when ace-server never sends module-ready', async () => {
    const fakeAce = createFakeAceServer();
    aceConnection = fakeAce.connection;
    mockedStartAceServer.mockReturnValue(fakeAce.handle);

    const clientIn = new PassThrough();
    const clientOut = new PassThrough();
    const env = createEnv();

    proxyHandle = createProxy(clientIn, clientOut, env, {
      env,
      projectRootHint: path.resolve('test/fixtures/sample-project'),
    });
    clientConnection = createMessageConnection(
      new StreamMessageReader(clientOut),
      new StreamMessageWriter(clientIn),
    );
    clientConnection.listen();

    await clientConnection.sendRequest('initialize', {
      processId: process.pid,
      rootUri: 'file:///tmp/not-the-arkts-project',
      capabilities: {},
    });
    clientConnection.sendNotification('initialized', {});
    clientConnection.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri: `file://${path.resolve('test/fixtures/sample-project/entry/src/main/ets/pages/Index.ets')}`,
        languageId: 'arkts',
        version: 1,
        text: '@Entry\n@Component\nstruct Index {}',
      },
    });

    const hover = await timeout(
      clientConnection.sendRequest('textDocument/hover', {
        textDocument: {
          uri: `file://${path.resolve('test/fixtures/sample-project/entry/src/main/ets/pages/Index.ets')}`,
        },
        position: { line: 1, character: 1 },
      }),
      250,
    );

    expect(hover).toEqual({ contents: 'hover-ok' });
    expect(fakeAce.events).toEqual([
      'request:initialize',
      'notification:initialized',
      'notification:aceProject/onAsyncDidOpen',
      'notification:aceProject/onAsyncHover',
    ]);
  });

  it('normalizes ace hover json payloads into markdown hover content', async () => {
    const fakeAce = createFakeAceServer({
      hoverResult: {
        range: {
          start: { line: 11, character: 6 },
          end: { line: 11, character: 9 },
        },
        contents: {
          kind: 'plaintext',
          value: JSON.stringify({
            code: {
              language: 'ts',
              value: 'const TAG: "Index"',
            },
            data: [
              {
                document: 'Symbol documentation',
                tags: [{ name: 'example', text: 'hover tag' }],
              },
            ],
          }),
        },
      },
    });
    aceConnection = fakeAce.connection;
    mockedStartAceServer.mockReturnValue(fakeAce.handle);

    const env = createEnv();
    const client = createClient(env);
    proxyHandle = client.handle;
    clientConnection = client.connection;

    const filePath = path.resolve('test/fixtures/sample-project/entry/src/main/ets/pages/Index.ets');
    const uri = `file://${filePath}`;

    await clientConnection.sendRequest('initialize', {
      processId: process.pid,
      rootUri: 'file:///tmp/not-the-arkts-project',
      capabilities: {},
    });
    clientConnection.sendNotification('initialized', {});
    clientConnection.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: 'arkts',
        version: 1,
        text: 'const TAG = "Index"',
      },
    });

    const hover = await timeout(
      clientConnection.sendRequest('textDocument/hover', {
        textDocument: { uri },
        position: { line: 0, character: 7 },
      }),
      250,
    );

    expect(hover).toEqual({
      range: {
        start: { line: 11, character: 6 },
        end: { line: 11, character: 9 },
      },
      contents: {
        kind: 'markdown',
        value: '```ts\nconst TAG: "Index"\n```\n\nSymbol documentation\n\n@example hover tag',
      },
    });
  });

  it('does not block initialize while hvigor sync is running in background', async () => {
    const fakeAce = createFakeAceServer();
    aceConnection = fakeAce.connection;
    mockedStartAceServer.mockReturnValue(fakeAce.handle);
    hvigorMocks.runHvigorSyncAsync.mockImplementationOnce(() => new Promise(() => {}));

    const env = createEnv();
    const client = createClient(env);
    proxyHandle = client.handle;
    clientConnection = client.connection;

    const result = await timeout(
      clientConnection.sendRequest('initialize', {
        processId: process.pid,
        rootUri: 'file:///tmp/not-the-arkts-project',
        capabilities: {},
      }),
      250,
    );

    expect(result).toMatchObject({
      capabilities: {
        hoverProvider: true,
        documentSymbolProvider: true,
        workspaceSymbolProvider: true,
      },
    });
    expect(hvigorMocks.runHvigorSyncAsync).toHaveBeenCalledOnce();
  });

  it('does not reject initialize when background hvigor sync fails', async () => {
    const fakeAce = createFakeAceServer();
    aceConnection = fakeAce.connection;
    mockedStartAceServer.mockReturnValue(fakeAce.handle);
    hvigorMocks.runHvigorSyncAsync.mockResolvedValueOnce({
      status: 'failed',
      reason: 'exit-code',
      metadataBefore: {
        state: 'missing',
        dependencyMapPath: '/fake/project/.hvigor/dependencyMap/dependencyMap.json5',
      },
      metadataAfter: {
        state: 'missing',
        dependencyMapPath: '/fake/project/.hvigor/dependencyMap/dependencyMap.json5',
      },
      elapsedMs: 10,
      exitCode: 1,
      errorMessage: 'sync failed',
    });

    const env = createEnv();
    const client = createClient(env);
    proxyHandle = client.handle;
    clientConnection = client.connection;

    const result = await timeout(
      clientConnection.sendRequest('initialize', {
        processId: process.pid,
        rootUri: 'file:///tmp/not-the-arkts-project',
        capabilities: {},
      }),
      250,
    );

    expect(result).toMatchObject({
      capabilities: {
        hoverProvider: true,
        documentSymbolProvider: true,
        workspaceSymbolProvider: true,
      },
    });
  });

  it('normalizes didOpen languageId and sends ace editor files as file paths', async () => {
    const fakeAce = createFakeAceServer();
    aceConnection = fakeAce.connection;
    mockedStartAceServer.mockReturnValue(fakeAce.handle);

    const env = createEnv();
    const client = createClient(env);
    proxyHandle = client.handle;
    clientConnection = client.connection;

    const filePath = path.resolve('test/fixtures/sample-project/entry/src/main/ets/pages/Index.ets');
    const uri = `file://${filePath}`;

    await clientConnection.sendRequest('initialize', {
      processId: process.pid,
      rootUri: 'file:///tmp/not-the-arkts-project',
      capabilities: {},
    });
    clientConnection.sendNotification('initialized', {});
    clientConnection.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: 'arkts',
        version: 1,
        text: '@Entry\n@Component\nstruct Index {}',
      },
    });

    await timeout(
      clientConnection.sendRequest('textDocument/hover', {
        textDocument: { uri },
        position: { line: 1, character: 1 },
      }),
      250,
    );

    const didOpen = fakeAce.notifications.find((n) => n.method === 'aceProject/onAsyncDidOpen');
    expect(didOpen?.params).toMatchObject({
      params: {
        textDocument: {
          uri,
          languageId: 'deveco.apptool.ets',
        },
      },
      editorFiles: [filePath],
    });
  });

  it('serves document symbols from opened ArkTS text without forwarding to ace', async () => {
    const fakeAce = createFakeAceServer();
    aceConnection = fakeAce.connection;
    mockedStartAceServer.mockReturnValue(fakeAce.handle);

    const env = createEnv();
    const client = createClient(env);
    proxyHandle = client.handle;
    clientConnection = client.connection;

    const filePath = path.resolve('test/fixtures/sample-project/entry/src/main/ets/pages/CameraPage.ets');
    const uri = `file://${filePath}`;

    await clientConnection.sendRequest('initialize', {
      processId: process.pid,
      rootUri: 'file:///tmp/not-the-arkts-project',
      capabilities: {},
    });
    clientConnection.sendNotification('initialized', {});
    clientConnection.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: 'arkts',
        version: 1,
        text: `@Entry
@Component
struct CameraPage {
  @State now: string = ''

  aboutToAppear(): void {
  }

  @Builder
  private Content() {
  }

  build() {
    Text(this.now)
  }
}

export class CameraViewModel {
}`,
      },
    });

    const symbols = await timeout(
      clientConnection.sendRequest('textDocument/documentSymbol', {
        textDocument: { uri },
      }),
      250,
    );

    expect(symbols).toMatchObject([
      {
        name: 'CameraPage',
        kind: 23,
        detail: '@Entry @Component',
        children: [
          { name: 'now', kind: 7, detail: '@State' },
          { name: 'aboutToAppear', kind: 6 },
          { name: 'Content', kind: 6, detail: '@Builder' },
          { name: 'build', kind: 6 },
        ],
      },
      {
        name: 'CameraViewModel',
        kind: 5,
      },
    ]);
    expect(fakeAce.events).not.toContain('request:textDocument/documentSymbol');
    expect(fakeAce.events).not.toContain('notification:textDocument/documentSymbol');
  });

  it('serves lightweight workspace symbols from the resolved ArkTS project root', async () => {
    const fakeAce = createFakeAceServer();
    aceConnection = fakeAce.connection;
    mockedStartAceServer.mockReturnValue(fakeAce.handle);

    const env = createEnv();
    const client = createClient(env);
    proxyHandle = client.handle;
    clientConnection = client.connection;

    const filePath = path.resolve('test/fixtures/sample-project/entry/src/main/ets/pages/CameraPage.ets');
    const uri = `file://${filePath}`;

    await clientConnection.sendRequest('initialize', {
      processId: process.pid,
      rootUri: 'file:///tmp/not-the-arkts-project',
      capabilities: {},
    });

    const symbols = await timeout(
      clientConnection.sendRequest('workspace/symbol', {
        query: 'CameraViewModel',
      }),
      250,
    );

    expect(symbols).toEqual([
      expect.objectContaining({
        name: 'CameraViewModel',
        kind: 5,
        location: expect.objectContaining({
          uri,
        }),
      }),
    ]);
    expect(fakeAce.events).not.toContain('request:workspace/symbol');
    expect(fakeAce.events).not.toContain('notification:workspace/symbol');
  });

  it('returns no workspace symbols when the query is empty', async () => {
    const fakeAce = createFakeAceServer();
    aceConnection = fakeAce.connection;
    mockedStartAceServer.mockReturnValue(fakeAce.handle);

    const env = createEnv();
    const client = createClient(env);
    proxyHandle = client.handle;
    clientConnection = client.connection;

    await clientConnection.sendRequest('initialize', {
      processId: process.pid,
      rootUri: 'file:///tmp/not-the-arkts-project',
      capabilities: {},
    });

    await expect(
      timeout(
        clientConnection.sendRequest('workspace/symbol', {
          query: '',
        }),
        250,
      ),
    ).resolves.toEqual([]);
  });

  it('supports alternate workspace symbol query fields from non-standard clients', async () => {
    const fakeAce = createFakeAceServer();
    aceConnection = fakeAce.connection;
    mockedStartAceServer.mockReturnValue(fakeAce.handle);

    const env = createEnv();
    const client = createClient(env);
    proxyHandle = client.handle;
    clientConnection = client.connection;

    const filePath = path.resolve('test/fixtures/sample-project/entry/src/main/ets/pages/CameraPage.ets');
    const uri = `file://${filePath}`;

    await clientConnection.sendRequest('initialize', {
      processId: process.pid,
      rootUri: 'file:///tmp/not-the-arkts-project',
      capabilities: {},
    });

    const symbols = await timeout(
      clientConnection.sendRequest('workspace/symbol', {
        pattern: 'CameraViewModel',
      }),
      250,
    );

    expect(symbols).toEqual([
      expect.objectContaining({
        name: 'CameraViewModel',
        kind: 5,
        location: expect.objectContaining({
          uri,
        }),
      }),
    ]);
  });

  it('returns no workspace symbols for non-matching queries', async () => {
    const fakeAce = createFakeAceServer();
    aceConnection = fakeAce.connection;
    mockedStartAceServer.mockReturnValue(fakeAce.handle);

    const env = createEnv();
    const client = createClient(env);
    proxyHandle = client.handle;
    clientConnection = client.connection;

    await clientConnection.sendRequest('initialize', {
      processId: process.pid,
      rootUri: 'file:///tmp/not-the-arkts-project',
      capabilities: {},
    });

    await expect(
      timeout(
        clientConnection.sendRequest('workspace/symbol', {
          query: 'SymbolThatDoesNotExistInFixture',
        }),
        250,
      ),
    ).resolves.toEqual([]);
  });

  it('maps standard references to ace find usages notifications', async () => {
    const fakeAce = createFakeAceServer();
    aceConnection = fakeAce.connection;
    mockedStartAceServer.mockReturnValue(fakeAce.handle);

    const env = createEnv();
    const client = createClient(env);
    proxyHandle = client.handle;
    clientConnection = client.connection;

    const filePath = path.resolve('test/fixtures/sample-project/entry/src/main/ets/pages/Index.ets');
    const uri = `file://${filePath}`;

    await clientConnection.sendRequest('initialize', {
      processId: process.pid,
      rootUri: 'file:///tmp/not-the-arkts-project',
      capabilities: {},
    });
    clientConnection.sendNotification('initialized', {});
    clientConnection.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: 'arkts',
        version: 1,
        text: '@Entry\n@Component\nstruct Index {}',
      },
    });

    const references = await timeout(
      clientConnection.sendRequest('textDocument/references', {
        textDocument: { uri },
        position: { line: 1, character: 3 },
        context: { includeDeclaration: true },
      }),
      250,
    );

    expect(fakeAce.events).toContain('notification:aceProject/onAsyncFindUsages');
    expect(references).toEqual([
      {
        uri: 'file:///tmp/project/entry/src/main/ets/pages/Index.ets',
        range: {
          start: { line: 1, character: 2 },
          end: { line: 1, character: 7 },
        },
      },
    ]);
  });
});
