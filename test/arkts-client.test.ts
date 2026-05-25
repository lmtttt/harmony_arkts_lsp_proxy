import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node';
import { ArktsLanguageClient, type ProxyFactory } from '../src/arkts-client';
import type { DevEcoEnv } from '../src/env';

const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'sample-project');
const CAMERA_PAGE = path.join(FIXTURE_DIR, 'entry', 'src', 'main', 'ets', 'pages', 'CameraPage.ets');

function createEnv(): DevEcoEnv {
  return {
    devecoHome: '/fake/deveco',
    sdkPath: '/fake/sdk',
    aceServerPath: '/fake/ace-server.js',
    nodeBin: process.execPath,
    hvigorPath: '/fake/hvigorw.js',
  };
}

describe('ArktsLanguageClient', () => {
  it('initializes one proxy session and sends hover requests with opened text', async () => {
    const events: Array<{ method: string; params: unknown }> = [];
    const connections: MessageConnection[] = [];
    let proxyCreateCount = 0;

    const proxyFactory: ProxyFactory = (clientIn, clientOut) => {
      proxyCreateCount += 1;
      const connection = createMessageConnection(
        new StreamMessageReader(clientIn as PassThrough),
        new StreamMessageWriter(clientOut as PassThrough),
      );
      connections.push(connection);
      connection.onRequest((method, params) => {
        events.push({ method, params });
        if (method === 'initialize') {
          return { capabilities: { hoverProvider: true } };
        }
        if (method === 'textDocument/hover') {
          return { contents: 'hover-ok' };
        }
        return null;
      });
      connection.onNotification((method, params) => {
        events.push({ method, params });
      });
      connection.listen();
      return {
        dispose: () => connection.dispose(),
      };
    };

    const client = new ArktsLanguageClient({
      envFinder: () => createEnv(),
      proxyFactory,
    });

    const hover = await client.hover({
      projectRoot: FIXTURE_DIR,
      filePath: CAMERA_PAGE,
      position: { line: 1, character: 3 },
    });

    expect(hover).toEqual({ contents: 'hover-ok' });
    expect(proxyCreateCount).toBe(1);
    expect(events.map((event) => event.method)).toEqual([
      'initialize',
      'initialized',
      'textDocument/didOpen',
      'textDocument/hover',
    ]);

    const didOpen = events.find((event) => event.method === 'textDocument/didOpen');
    expect(didOpen?.params).toMatchObject({
      textDocument: {
        uri: expect.stringContaining('CameraPage.ets'),
        languageId: 'arkts',
        version: 1,
        text: expect.stringContaining('CameraPage'),
      },
    });

    client.dispose();
    for (const connection of connections) {
      connection.dispose();
    }
  });

  it('reuses an initialized proxy session for the same project', async () => {
    let proxyCreateCount = 0;
    const proxyFactory: ProxyFactory = (clientIn, clientOut) => {
      proxyCreateCount += 1;
      const connection = createMessageConnection(
        new StreamMessageReader(clientIn as PassThrough),
        new StreamMessageWriter(clientOut as PassThrough),
      );
      connection.onRequest((method) => {
        if (method === 'initialize') {
          return { capabilities: { hoverProvider: true } };
        }
        if (method === 'textDocument/definition') {
          return [{ uri: 'file:///tmp/Index.ets' }];
        }
        return null;
      });
      connection.listen();
      return {
        dispose: () => connection.dispose(),
      };
    };

    const client = new ArktsLanguageClient({
      envFinder: () => createEnv(),
      proxyFactory,
    });

    await client.definition({
      projectRoot: FIXTURE_DIR,
      filePath: CAMERA_PAGE,
      position: { line: 1, character: 3 },
    });
    await client.definition({
      projectRoot: FIXTURE_DIR,
      filePath: CAMERA_PAGE,
      position: { line: 2, character: 3 },
    });

    expect(proxyCreateCount).toBe(1);
    client.dispose();
  });
});
