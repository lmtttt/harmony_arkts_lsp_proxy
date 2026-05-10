import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node';
import { ErrorCodes, ResponseError } from 'vscode-jsonrpc';
import type { ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseProject,
  findProjectRoot,
  buildInitializationOptions,
  type ProjectConfig,
  type AceModule,
} from './project';
import { startAceServer, type AceServerHandle } from './ace-server';
import { parseHvigorSyncConfig, runHvigorSyncAsync } from './hvigor';
import type { DevEcoEnv } from './env';

type RpcParams = Record<string, unknown> | undefined;
type RpcResult = unknown;
type RpcPayload = Record<string, unknown>;

type RawClientMessage = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
};

interface LegacyPayload extends Record<string, unknown> {
  rootUri: string;
  lspServerWorkspacePath: string;
  modules: AceModule[];
}

interface LegacyMessageAdapter {
  process?: ChildProcess;
  connection?: MessageConnection;
}

interface ModernMode {
  env: DevEcoEnv;
  projectRootHint?: string;
}

type CreateProxyOptions = ModernMode | LegacyPayload;

interface QueuedRequest {
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

interface QueuedNotification {
  method: string;
  params: RpcPayload;
}

interface PendingAceRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

export interface InitializationPayload {
  rootUri: string;
  lspServerWorkspacePath: string;
  modules: AceModule[];
}

export interface ProxyHandle {
  dispose: () => void;
}

const ACE_NOTIFICATION_METHODS: Record<string, string> = {
  'textDocument/didOpen': 'aceProject/onAsyncDidOpen',
  'textDocument/didChange': 'aceProject/onAsyncDidChange',
  'textDocument/didClose': 'aceProject/onAsyncDidClose',
};

const ACE_FIND_USAGES_METHOD = 'aceProject/onAsyncFindUsages';

const ACE_REQUEST_METHODS: Record<string, string> = {
  'textDocument/hover': 'aceProject/onAsyncHover',
  'textDocument/completion': 'aceProject/onAsyncCompletion',
  'completionItem/resolve': 'aceProject/onAsyncCompletionResolve',
  'textDocument/definition': 'aceProject/onAsyncDefinition',
  'textDocument/references': ACE_FIND_USAGES_METHOD,
  'textDocument/signatureHelp': 'aceProject/onAsyncSignatureHelp',
};

const ACE_RESPONSE_METHODS = new Set(Object.values(ACE_REQUEST_METHODS));
const ACE_MODULE_INIT_METHOD = 'aceProject/onModuleInitFinish';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function sanitizeMarkdownLanguage(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[^A-Za-z0-9_+#.-]/g, '') : '';
}

function extractHoverTag(tag: unknown): string | null {
  if (typeof tag === 'string') {
    const trimmed = tag.trim();
    return trimmed.length ? trimmed : null;
  }

  if (!isPlainObject(tag)) {
    return null;
  }

  const name = typeof tag.name === 'string' ? tag.name.trim() : '';
  const textValue = tag.text ?? tag.comment ?? tag.documentation;
  const text = typeof textValue === 'string' ? decodeHtmlEntities(textValue).trim() : '';

  if (name && text) {
    return `@${name} ${text}`;
  }
  if (name) {
    return `@${name}`;
  }
  return text.length ? text : null;
}

function extractHoverDocuments(data: unknown): string[] {
  const documents: string[] = [];
  const items = Array.isArray(data) ? data : [data];

  for (const item of items) {
    if (!isPlainObject(item)) {
      continue;
    }

    if (typeof item.document === 'string') {
      const document = decodeHtmlEntities(item.document).trim();
      if (document.length) {
        documents.push(document);
      }
    }

    if (Array.isArray(item.tags)) {
      for (const tag of item.tags) {
        const formatted = extractHoverTag(tag);
        if (formatted) {
          documents.push(formatted);
        }
      }
    }
  }

  return documents;
}

function parseAceHoverPayload(value: string): Record<string, unknown> | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isPlainObject(parsed)) {
      return null;
    }
    if (!isPlainObject(parsed.code) && !('data' in parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function normalizeAceHoverContents(contents: unknown): unknown {
  const rawValue = typeof contents === 'string'
    ? contents
    : isPlainObject(contents) && typeof contents.value === 'string'
      ? contents.value
      : null;

  if (!rawValue) {
    return contents;
  }

  const payload = parseAceHoverPayload(rawValue);
  if (!payload) {
    return contents;
  }

  const parts: string[] = [];
  const code = isPlainObject(payload.code) ? payload.code : null;
  const codeValue = typeof code?.value === 'string' ? decodeHtmlEntities(code.value).trim() : '';
  if (codeValue.length) {
    const language = sanitizeMarkdownLanguage(code?.language);
    parts.push(`\`\`\`${language}\n${codeValue}\n\`\`\``);
  }

  parts.push(...extractHoverDocuments(payload.data));

  if (parts.length === 0) {
    return contents;
  }

  return {
    kind: 'markdown',
    value: parts.join('\n\n'),
  };
}

function normalizeHoverResult(result: unknown): unknown {
  if (!isPlainObject(result) || !('contents' in result)) {
    return result;
  }

  const contents = normalizeAceHoverContents(result.contents);
  if (contents === result.contents) {
    return result;
  }

  return {
    ...result,
    contents,
  };
}

function normalizeClientResult(method: string, result: unknown): unknown {
  if (method === 'textDocument/hover') {
    return normalizeHoverResult(result);
  }
  return result;
}

function createQueueToken(): string {
  return `arkts-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function uriToFilePath(uri: unknown): string | null {
  if (typeof uri !== 'string' || !uri.length) {
    return null;
  }
  if (uri.startsWith('file://')) {
    try {
      return fileURLToPath(uri);
    } catch {
      return null;
    }
  }
  return path.resolve(uri);
}

function detectLanguageId(uri: string): string {
  const ext = path.extname(uri).toLowerCase();
  if (ext === '.ets' || ext === '.d.ets') {
    return 'deveco.apptool.ets';
  }
  if (ext === '.ts') {
    return 'deveco.apptool.ts';
  }
  if (ext === '.js') {
    return 'deveco.apptool.js';
  }
  return 'deveco.apptool.ts';
}

function normalizeAceLanguageId(uri: string, languageId: unknown): string {
  if (typeof languageId === 'string' && languageId.startsWith('deveco.apptool.')) {
    return languageId;
  }
  return detectLanguageId(uri);
}

function inferProjectRootFromInitializeParams(params: RpcParams): string | null {
  if (!isPlainObject(params)) {
    return null;
  }
  const candidate =
    (Array.isArray(params.workspaceFolders)
      ? (params.workspaceFolders as Array<{ uri?: string }>)[0]?.uri
      : undefined) ??
    (params.rootUri as string | undefined) ??
    (params.rootPath as string | undefined);

  return uriToFilePath(candidate ?? null);
}

function getEditorFiles(openFiles: Set<string>): string[] {
  return Array.from(openFiles)
    .map((uri) => uriToFilePath(uri))
    .filter((filePath): filePath is string => Boolean(filePath));
}

function getOpenFileUris(openFiles: Set<string>): string[] {
  return Array.from(openFiles);
}

function createRequestPayload(params: RpcParams): RpcPayload {
  return {
    requestId: createQueueToken(),
    params: params || {},
    editorFiles: [],
    traceId: createQueueToken(),
  };
}

function isModuleInitSuccess(payload: unknown): boolean {
  if (Array.isArray(payload)) {
    return payload.length > 0 && payload.every(isModuleInitSuccess);
  }
  if (typeof payload === 'boolean') {
    return payload;
  }
  if (!isPlainObject(payload)) {
    return false;
  }
  if ('success' in payload && typeof payload.success === 'boolean') {
    return payload.success;
  }
  if ('code' in payload && typeof payload.code === 'number') {
    return payload.code === 0;
  }
  if ('status' in payload && typeof payload.status === 'string') {
    return payload.status.toLowerCase() === 'success';
  }
  if ('result' in payload && typeof payload.result === 'boolean') {
    return payload.result;
  }
  return false;
}

function extractTextDocument(params: RpcParams): Record<string, unknown> | null {
  if (!isPlainObject(params)) {
    return null;
  }
  const textDocument = (params.textDocument as unknown) ?? null;
  return isPlainObject(textDocument) ? (textDocument as Record<string, unknown>) : null;
}

function mapNotification(method: string, params: RpcParams, openFiles: Set<string>): { method: string; params: RpcPayload } | null {
  if (!ACE_NOTIFICATION_METHODS[method]) {
    return null;
  }

  if (method === 'textDocument/didOpen') {
    const textDocument = extractTextDocument(params);
    if (!textDocument) {
      return null;
    }
    const uri = typeof textDocument.uri === 'string' ? textDocument.uri : null;
    if (!uri) {
      return null;
    }
    return {
      method: ACE_NOTIFICATION_METHODS[method],
      params: {
        requestId: createQueueToken(),
        params: {
          textDocument: {
            uri,
            languageId: normalizeAceLanguageId(uri, textDocument.languageId),
            version: textDocument.version,
            text: typeof textDocument.text === 'string' ? textDocument.text : '',
          },
        },
        editorFiles: getEditorFiles(openFiles),
        traceId: createQueueToken(),
      },
    };
  }

  if (method === 'textDocument/didClose') {
    const textDocument = extractTextDocument(params);
    if (!textDocument) {
      return null;
    }
    const uri = typeof textDocument.uri === 'string' ? textDocument.uri : null;
    if (!uri) {
      return null;
    }
    return {
      method: ACE_NOTIFICATION_METHODS[method],
      params: {
        requestId: createQueueToken(),
        params: {
          textDocument,
        },
        editorFiles: getEditorFiles(openFiles),
        traceId: createQueueToken(),
      },
    };
  }

  if (method === 'textDocument/didChange') {
    const textDocument = extractTextDocument(params);
    if (!textDocument) {
      return null;
    }
    const uri = typeof textDocument.uri === 'string' ? textDocument.uri : null;
    if (!uri) {
      return null;
    }
    return {
      method: ACE_NOTIFICATION_METHODS[method],
      params: {
        requestId: createQueueToken(),
        params: {
          textDocument: {
            uri,
            languageId: detectLanguageId(uri),
            version: textDocument.version,
            text: typeof textDocument.text === 'string' ? textDocument.text : '',
          },
          contentChanges: Array.isArray(params?.contentChanges) ? params.contentChanges : [],
        },
        editorFiles: getEditorFiles(openFiles),
        traceId: createQueueToken(),
      },
    };
  }

  return {
    method: ACE_NOTIFICATION_METHODS[method],
    params: {
      ...createRequestPayload(params),
      editorFiles: getEditorFiles(openFiles),
    },
  };
}

function mapRequest(method: string, params: RpcParams, openFiles: Set<string>): { method: string; params: RpcPayload } | null {
  const mappedMethod = ACE_REQUEST_METHODS[method];
  if (!mappedMethod) {
    return null;
  }
  const payload = {
    ...createRequestPayload(params),
    editorFiles: getEditorFiles(openFiles),
  } as RpcPayload;

  if (method === 'textDocument/definition') {
    payload.params = {
      ...(isPlainObject(payload.params) ? payload.params : {}),
      isGotoDefinition: true,
    };
  }

  return {
    method: mappedMethod,
    params: payload,
  };
}

function isDevEcoEnv(value: unknown): value is DevEcoEnv {
  return (
    isPlainObject(value) &&
    typeof value.devecoHome === 'string' &&
    typeof value.sdkPath === 'string' &&
    typeof value.aceServerPath === 'string' &&
    typeof value.nodeBin === 'string' &&
    typeof value.hvigorPath === 'string'
  );
}

function isLegacyPayload(value: unknown): value is LegacyPayload {
  return (
    isPlainObject(value) &&
    typeof value.rootUri === 'string' &&
    typeof value.lspServerWorkspacePath === 'string' &&
    Array.isArray(value.modules)
  );
}

function isModernMode(value: unknown): value is ModernMode {
  return isPlainObject(value) && isDevEcoEnv(value.env);
}

export function injectInitializationOptions(
  message: RawClientMessage,
  payload: Record<string, unknown>,
): RawClientMessage {
  if (message.method !== 'initialize' || !message.params) {
    return message;
  }

  const params = { ...message.params } as RpcPayload;
  const existing =
    typeof (params.initializationOptions as Record<string, unknown> | undefined) === 'object' &&
    params.initializationOptions !== null
      ? (params.initializationOptions as Record<string, unknown>)
      : {};

  params.initializationOptions = {
    ...existing,
    ...payload,
  };

  return { ...message, params };
}

function createLegacyProxy(
  clientConn: MessageConnection,
  proc: ChildProcess,
  payload?: LegacyPayload,
): ProxyHandle {
  if (!proc.stdout || !proc.stdin) {
    throw new Error('aceProcess must have both stdout and stdin streams');
  }

  const aceConn = createMessageConnection(new StreamMessageReader(proc.stdout), new StreamMessageWriter(proc.stdin));
  let disposed = false;

  clientConn.onRequest((method, params) => {
    if (method === 'initialize' && payload) {
      const msg = injectInitializationOptions(
        {
          id: 0,
          method,
          params: isPlainObject(params) ? (params as RpcPayload) : {},
        },
        payload,
      );
      return aceConn.sendRequest(method, msg.params as RpcPayload);
    }
    return aceConn.sendRequest(method, params);
  });

  aceConn.onNotification((method, params) => {
    clientConn.sendNotification(method, params);
  });

  aceConn.onError((error) => {
    process.stderr.write(`[arkts-lsp] legacy ace connection error: ${String(error)}\n`);
  });

  clientConn.onNotification((method, params) => {
    aceConn.sendNotification(method, params);
  });
  clientConn.onError((error) => {
    process.stderr.write(`[arkts-lsp] client connection error: ${String(error)}\n`);
  });

  clientConn.listen();
  aceConn.listen();

  return {
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      clientConn.dispose();
      aceConn.dispose();
    },
  };
}

export function createProxy(
  clientIn: NodeJS.ReadableStream,
  clientOut: NodeJS.WritableStream,
  envOrLegacy: DevEcoEnv | LegacyMessageAdapter,
  maybeOptions?: CreateProxyOptions,
): ProxyHandle {
  const clientConn = createMessageConnection(new StreamMessageReader(clientIn), new StreamMessageWriter(clientOut));

  if (!isDevEcoEnv(envOrLegacy)) {
    const legacyProc = (envOrLegacy as LegacyMessageAdapter).process ?? (envOrLegacy as ChildProcess);
    if (!legacyProc) {
      throw new Error('legacy mode requires ChildProcess-like object with stdin/stdout streams');
    }
      return createLegacyProxy(clientConn, legacyProc, isLegacyPayload(maybeOptions) ? maybeOptions : undefined);
  }

  const env = envOrLegacy;
  const options: ModernMode = isModernMode(maybeOptions) ? maybeOptions : { env, projectRootHint: undefined };

  const explicitProjectRoot = options.projectRootHint || process.env.ARKTS_PROJECT_ROOT || process.env.ARKTS_PROJECT_PATH;

  const openFiles = new Set<string>();
  const requestQueue: Array<QueuedRequest> = [];
  const notificationQueue: Array<QueuedNotification> = [];
  const pendingAceRequests = new Map<string, PendingAceRequest>();
  let isInitialized = false;
  let isServerReady = false;
  let isBootstrapping = false;
  let bootstrapPromise: Promise<MessageConnection> | null = null;
  let initializePromise: Promise<unknown> | null = null;
  let syncPromise: Promise<void> | null = null;
  let aceConn: MessageConnection | null = null;
  let aceHandle: AceServerHandle | null = null;
  let project: ProjectConfig | null = null;
  let disposed = false;

  function queueRequest(run: () => Promise<unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      requestQueue.push({ run, resolve, reject });
    });
  }

  function queueNotification(method: string, params: RpcPayload): void {
    notificationQueue.push({ method, params });
  }

  function clearQueues(error?: unknown): void {
    const finalError = error ?? new Error('proxy disposed');
    while (requestQueue.length > 0) {
      const p = requestQueue.shift();
      if (p) {
        p.reject(finalError);
      }
    }
    notificationQueue.length = 0;
    for (const pending of pendingAceRequests.values()) {
      pending.reject(finalError);
    }
    pendingAceRequests.clear();
  }

  function flushQueues(): void {
    if (!isServerReady || !aceConn) {
      return;
    }

    while (notificationQueue.length > 0) {
      const n = notificationQueue.shift();
      if (!n) {
        continue;
      }
      try {
        aceConn.sendNotification(n.method, n.params);
      } catch {
        // ignore flush notification errors
      }
    }

    while (requestQueue.length > 0) {
      const p = requestQueue.shift();
      if (!p) {
        continue;
      }
      p.run().then(p.resolve, p.reject);
    }
  }

  function completePendingAceRequest(method: string, params: unknown): boolean {
    if (!ACE_RESPONSE_METHODS.has(method) || !isPlainObject(params)) {
      return false;
    }

    const requestId = typeof params.requestId === 'string' ? params.requestId : null;
    if (!requestId) {
      return false;
    }

    const pending = pendingAceRequests.get(requestId);
    if (!pending) {
      return false;
    }

    pendingAceRequests.delete(requestId);
    pending.resolve('result' in params ? params.result : params);
    return true;
  }

  function sendAceRequestAsNotification(conn: MessageConnection, method: string, params: RpcPayload): Promise<unknown> {
    const requestId = typeof params.requestId === 'string' ? params.requestId : createQueueToken();
    const payload = { ...params, requestId };

    return new Promise((resolve, reject) => {
      pendingAceRequests.set(requestId, { resolve, reject });
      try {
        conn.sendNotification(method, payload);
      } catch (err) {
        pendingAceRequests.delete(requestId);
        reject(err);
      }
    });
  }

  function sendAceRequest(
    conn: MessageConnection,
    method: string,
    params: RpcPayload,
    useNotificationResponse: boolean,
  ): Promise<unknown> {
    return useNotificationResponse
      ? sendAceRequestAsNotification(conn, method, params)
      : conn.sendRequest(method, params);
  }

  function createAceConnection(proc: ChildProcess): MessageConnection {
    if (!proc.stdout || !proc.stdin) {
      throw new Error('aceProcess must have both stdout and stdin streams');
    }
    const conn = createMessageConnection(new StreamMessageReader(proc.stdout), new StreamMessageWriter(proc.stdin));

    conn.onNotification((method, params) => {
      if (completePendingAceRequest(method, params)) {
        return;
      }
      if (method === ACE_MODULE_INIT_METHOD) {
        if (isModuleInitSuccess(params)) {
          isServerReady = true;
          flushQueues();
        } else {
          process.stderr.write('[arkts-lsp] ace server module init reported failure, continue serving requests\n');
        }
      }
      clientConn.sendNotification(method, params);
    });

    conn.onRequest((method, params) => {
      if (method === 'client/registerCapability') {
        return null;
      }
      return clientConn.sendRequest(method, params).catch((error) => {
        process.stderr.write(`[arkts-lsp] client request ${method} failed: ${String(error)}\n`);
        return null;
      });
    });

    conn.onError((error) => {
      process.stderr.write(`[arkts-lsp] ace connection error: ${String(error)}\n`);
      clearQueues(error);
    });

    return conn;
  }

  function scheduleHvigorSync(projectRoot: string): void {
    if (syncPromise) {
      return;
    }

    const config = parseHvigorSyncConfig();
    process.stderr.write(`[arkts-lsp] hvigor metadata sync mode=${config.mode}, timeout=${config.timeoutMs}ms\n`);

    syncPromise = runHvigorSyncAsync(env, projectRoot, config)
      .then((result) => {
        const before = result.metadataBefore.state;
        const after = result.metadataAfter?.state ?? before;
        process.stderr.write(
          `[arkts-lsp] hvigor sync ${result.status}; metadata ${before} -> ${after}; elapsed=${result.elapsedMs}ms\n`,
        );
        if (result.errorMessage) {
          process.stderr.write(`[arkts-lsp] hvigor sync detail: ${result.errorMessage}\n`);
        }
      })
      .catch((error) => {
        process.stderr.write(`[arkts-lsp] hvigor sync unexpected error: ${String(error)}\n`);
      })
      .finally(() => {
        syncPromise = null;
      });
  }

  function ensureServer(rootHint: string | null): Promise<MessageConnection> {
    if (bootstrapPromise) {
      return bootstrapPromise;
    }

    bootstrapPromise = (async () => {
      isBootstrapping = true;
      const candidate = explicitProjectRoot
        ? path.resolve(explicitProjectRoot)
        : rootHint
          ? path.resolve(rootHint)
          : process.cwd();
      const resolvedRoot = findProjectRoot(candidate);
      if (!resolvedRoot) {
        throw new ResponseError(ErrorCodes.InvalidParams, 'No ArkTS project root found in workspace.');
      }

      const parsed = parseProject(resolvedRoot, env.sdkPath);
      if (!parsed) {
        throw new ResponseError(ErrorCodes.InvalidParams, `Unable to parse build-profile.json5 at ${resolvedRoot}`);
      }
      project = parsed;

      scheduleHvigorSync(parsed.projectRoot);

      const handle = startAceServer(env);
      aceHandle = handle;
      const conn = createAceConnection(handle.process);
      aceConn = conn;
      conn.listen();
      handle.onExit((code, signal) => {
        if (disposed) {
          return;
        }
        process.stderr.write(`[arkts-lsp] ace-server exited (code=${code}, signal=${signal})\n`);
        clearQueues(new ResponseError(ErrorCodes.InternalError, 'ace-server exited unexpectedly'));
      });

      return conn;
    })();

    const runningPromise = bootstrapPromise;
    runningPromise.finally(() => {
      isBootstrapping = false;
      if (bootstrapPromise === runningPromise) {
        bootstrapPromise = null;
      }
    });

    return runningPromise;
  }

  function resolveInitializeRequest(params: RpcParams): Promise<unknown> {
    if (initializePromise) {
      return initializePromise;
    }

    const initRootHint = inferProjectRootFromInitializeParams(params);
    initializePromise = (async () => {
      const connection = await ensureServer(initRootHint);
      if (!project) {
        throw new ResponseError(ErrorCodes.InvalidParams, 'Project not available');
      }

      const payload = buildInitializationOptions(project);
      const initMessage = injectInitializationOptions(
        {
          id: 0,
          method: 'initialize',
          params: isPlainObject(params) ? params : {},
        },
        payload,
      );

    const initParams = (initMessage.params || {}) as Record<string, unknown>;
      if (getEditorFiles(openFiles).length > 0) {
        initParams.editorFiles = getEditorFiles(openFiles);
      }

      const result = await connection.sendRequest('initialize', initParams);
      isInitialized = true;
      isServerReady = true;
      flushQueues();
      return result;
    })().catch((err) => {
      isInitialized = false;
      clearQueues(err);
      throw err;
    }).finally(() => {
      initializePromise = null;
    });

    return initializePromise;
  }

  function onRequest(method: string, params: RpcParams): Promise<RpcResult> {
    if (method === 'initialize') {
      return resolveInitializeRequest(params) as Promise<RpcResult>;
    }

    if (!isInitialized && !initializePromise) {
      return Promise.reject(new ResponseError(ErrorCodes.ServerNotInitialized, 'Initialize first.'));
    }

    const mapped = mapRequest(method, params, openFiles);
    const targetMethod = mapped?.method ?? method;
    const targetParams = mapped?.params ?? createRequestPayload(params);
    const useNotificationResponse = Boolean(mapped);
    const sendToAce = (conn: MessageConnection): Promise<unknown> =>
      sendAceRequest(conn, targetMethod, targetParams, useNotificationResponse).then((result) =>
        normalizeClientResult(method, result),
      );

    if (!aceConn) {
      if (!initializePromise) {
        return Promise.reject(new ResponseError(ErrorCodes.InternalError, 'ace connection is not ready'));
      }
      return queueRequest(() => {
        if (!aceConn) {
          return Promise.reject(new ResponseError(ErrorCodes.InternalError, 'ace connection is not ready'));
        }
        return sendToAce(aceConn);
      });
    }

    if (!isServerReady) {
      const activeConn = aceConn;
      if (!activeConn) {
        return Promise.reject(new ResponseError(ErrorCodes.InternalError, 'ace connection is not ready'));
      }
      return queueRequest(() => sendToAce(activeConn));
    }

    return sendToAce(aceConn);
  }

  function onNotification(method: string, params: RpcParams): void {
    if (method === 'textDocument/didOpen') {
      const textDocument = isPlainObject(params) ? (params.textDocument as Record<string, unknown>) : undefined;
      const uri = isPlainObject(textDocument) ? (textDocument.uri as string | undefined) : undefined;
      if (uri && typeof uri === 'string') {
        openFiles.add(uri);
      }
    }

    if (method === 'textDocument/didClose') {
      const textDocument = isPlainObject(params) ? (params.textDocument as Record<string, unknown>) : undefined;
      const uri = isPlainObject(textDocument) ? (textDocument.uri as string | undefined) : undefined;
      if (uri && typeof uri === 'string') {
        openFiles.delete(uri);
      }
    }

    if (method === 'initialized') {
      const editors = getOpenFileUris(openFiles).map((uri) => ({ uri, selected: true, receivedOpened: false }));
      const payload = {
        ...(isPlainObject(params) ? params : {}),
        editors,
      };
      if (!aceConn) {
        queueNotification('initialized', payload);
        return;
      }
      aceConn.sendNotification('initialized', payload);
      return;
    }

    const mapped = mapNotification(method, params, openFiles);
    const finalMethod = mapped ? mapped.method : method;
    const finalParams = mapped ? mapped.params : (createRequestPayload(params) as RpcPayload);

    if (!isServerReady || !aceConn) {
      queueNotification(finalMethod, finalParams);
      return;
    }

    try {
      aceConn.sendNotification(finalMethod, finalParams);
    } catch {
      queueNotification(finalMethod, finalParams);
    }
  }

  clientConn.onRequest((method, params) => {
    return onRequest(method, params as RpcParams);
  });

  clientConn.onNotification((method, params) => {
    onNotification(method, params as RpcParams);
  });

  clientConn.onError((error) => {
    process.stderr.write(`[arkts-lsp] client connection error: ${String(error)}\n`);
  });

  clientConn.listen();

  return {
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      clearQueues(new Error('disposed'));
      if (aceHandle) {
        aceHandle.dispose();
      }
      if (bootstrapPromise && isBootstrapping) {
        bootstrapPromise = null;
      }
      clientConn.dispose();
    },
  };
}
