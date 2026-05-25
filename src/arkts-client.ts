import * as fs from 'node:fs';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node';
import { findDevEcoEnv, type DevEcoEnv } from './env';
import { createProxy, type ProxyHandle } from './proxy';
import { findProjectRoot } from './project';

export interface Position {
  line: number;
  character: number;
}

export interface ArktsRequest {
  projectRoot?: string;
  filePath: string;
  position: Position;
  text?: string;
}

export interface ArktsDiagnosticsRequest {
  projectRoot?: string;
  filePath: string;
  text?: string;
  timeoutMs?: number;
}

interface ArktsPositionRequest extends ArktsRequest {
  context?: unknown;
}

export type ProxyFactory = (
  clientIn: NodeJS.ReadableStream,
  clientOut: NodeJS.WritableStream,
  env: DevEcoEnv,
  options: { env: DevEcoEnv; projectRootHint?: string },
) => ProxyHandle;

export interface ArktsLanguageClientOptions {
  envFinder?: () => DevEcoEnv | null;
  proxyFactory?: ProxyFactory;
}

interface OpenDocument {
  text: string;
  version: number;
}

interface Session {
  projectRoot: string;
  connection: MessageConnection;
  handle: ProxyHandle;
  documents: Map<string, OpenDocument>;
  diagnostics: Map<string, unknown[]>;
  pendingDiagnostics: Map<string, Array<(diagnostics: unknown[]) => void>>;
}

const defaultProxyFactory: ProxyFactory = (clientIn, clientOut, env, options) =>
  createProxy(clientIn, clientOut, env, options);

function resolveProjectRoot(projectRoot: string | undefined, filePath: string): string {
  const candidate = projectRoot ? path.resolve(projectRoot) : path.resolve(filePath);
  const resolved = findProjectRoot(candidate);
  if (!resolved) {
    throw new Error(`No ArkTS project root found for ${candidate}`);
  }
  return resolved;
}

function readDocumentText(filePath: string, explicitText?: string): string {
  if (typeof explicitText === 'string') {
    return explicitText;
  }
  return fs.readFileSync(filePath, 'utf8');
}

export class ArktsLanguageClient {
  private readonly envFinder: () => DevEcoEnv | null;
  private readonly proxyFactory: ProxyFactory;
  private readonly sessions = new Map<string, Promise<Session>>();

  constructor(options: ArktsLanguageClientOptions = {}) {
    this.envFinder = options.envFinder ?? findDevEcoEnv;
    this.proxyFactory = options.proxyFactory ?? defaultProxyFactory;
  }

  async hover(request: ArktsRequest): Promise<unknown> {
    return this.sendPositionRequest('textDocument/hover', request);
  }

  async definition(request: ArktsRequest): Promise<unknown> {
    return this.sendPositionRequest('textDocument/definition', request);
  }

  async references(request: ArktsRequest): Promise<unknown> {
    return this.sendPositionRequest('textDocument/references', {
      ...request,
      context: { includeDeclaration: true },
    });
  }

  async signatureHelp(request: ArktsRequest): Promise<unknown> {
    return this.sendPositionRequest('textDocument/signatureHelp', request);
  }

  async diagnostics(request: ArktsDiagnosticsRequest): Promise<unknown[]> {
    const filePath = path.resolve(request.filePath);
    const projectRoot = resolveProjectRoot(request.projectRoot, filePath);
    const session = await this.getSession(projectRoot);
    const uri = await this.ensureDocument(session, filePath, request.text);
    const existing = session.diagnostics.get(uri);
    if (existing) {
      return existing;
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve(session.diagnostics.get(uri) ?? []);
      }, request.timeoutMs ?? 1500);
      const pending = session.pendingDiagnostics.get(uri) ?? [];
      pending.push((diagnostics) => {
        clearTimeout(timeout);
        resolve(diagnostics);
      });
      session.pendingDiagnostics.set(uri, pending);
    });
  }

  dispose(): void {
    for (const promise of this.sessions.values()) {
      promise.then((session) => session.handle.dispose()).catch(() => undefined);
    }
    this.sessions.clear();
  }

  private async sendPositionRequest(method: string, request: ArktsPositionRequest): Promise<unknown> {
    const filePath = path.resolve(request.filePath);
    const projectRoot = resolveProjectRoot(request.projectRoot, filePath);
    const session = await this.getSession(projectRoot);
    const uri = await this.ensureDocument(session, filePath, request.text);

    return session.connection.sendRequest(method, {
      textDocument: { uri },
      position: request.position,
      ...(request.context ? { context: request.context } : {}),
    });
  }

  private getSession(projectRoot: string): Promise<Session> {
    const existing = this.sessions.get(projectRoot);
    if (existing) {
      return existing;
    }

    const created = this.createSession(projectRoot).catch((error) => {
      this.sessions.delete(projectRoot);
      throw error;
    });
    this.sessions.set(projectRoot, created);
    return created;
  }

  private async createSession(projectRoot: string): Promise<Session> {
    const env = this.envFinder();
    if (!env) {
      throw new Error('DevEco Studio not found. Set DEVECO_HOME or ARKTS_DEVECO_HOME.');
    }

    const clientIn = new PassThrough();
    const clientOut = new PassThrough();
    const handle = this.proxyFactory(clientIn, clientOut, env, { env, projectRootHint: projectRoot });
    const connection = createMessageConnection(
      new StreamMessageReader(clientOut),
      new StreamMessageWriter(clientIn),
    );

    const session: Session = {
      projectRoot,
      connection,
      handle,
      documents: new Map(),
      diagnostics: new Map(),
      pendingDiagnostics: new Map(),
    };

    connection.onNotification('textDocument/publishDiagnostics', (params) => {
      const payload = params as { uri?: unknown; diagnostics?: unknown };
      if (typeof payload.uri !== 'string') {
        return;
      }
      const diagnostics = Array.isArray(payload.diagnostics) ? payload.diagnostics : [];
      session.diagnostics.set(payload.uri, diagnostics);
      const pending = session.pendingDiagnostics.get(payload.uri) ?? [];
      session.pendingDiagnostics.delete(payload.uri);
      for (const resolve of pending) {
        resolve(diagnostics);
      }
    });

    connection.listen();
    await connection.sendRequest('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(projectRoot).toString(),
      workspaceFolders: [
        {
          uri: pathToFileURL(projectRoot).toString(),
          name: path.basename(projectRoot),
        },
      ],
      capabilities: {
        textDocument: {
          hover: { contentFormat: ['markdown', 'plaintext'] },
        },
      },
    });
    connection.sendNotification('initialized', {});
    return session;
  }

  private async ensureDocument(session: Session, filePath: string, explicitText?: string): Promise<string> {
    const uri = pathToFileURL(filePath).toString();
    const text = readDocumentText(filePath, explicitText);
    const opened = session.documents.get(uri);

    if (!opened) {
      session.documents.set(uri, { text, version: 1 });
      session.connection.sendNotification('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: 'arkts',
          version: 1,
          text,
        },
      });
      return uri;
    }

    if (opened.text !== text) {
      const next = { text, version: opened.version + 1 };
      session.documents.set(uri, next);
      session.connection.sendNotification('textDocument/didChange', {
        textDocument: {
          uri,
          version: next.version,
        },
        contentChanges: [{ text }],
      });
    }

    return uri;
  }
}
