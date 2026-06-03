import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node';
import { ErrorCodes, ResponseError } from 'vscode-jsonrpc';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
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
import { parseDocumentSymbols, parseWorkspaceSymbols } from './symbols';
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
  'textDocument/rename': 'aceProject/onAsyncRename',
  'textDocument/prepareRename': 'aceProject/onAsyncPrepareRename',
  'textDocument/codeAction': 'aceProject/onAsyncCodeAction',
  'textDocument/implementation': 'aceProject/onAsyncImplementation',
  'textDocument/documentHighlight': 'aceProject/onAsyncDocumentHighlight',
  'textDocument/documentLink': 'aceProject/onAsyncDocumentLinks',
  'textDocument/inlayHint': 'aceProject/onInlayHints',
  'textDocument/prepareCallHierarchy': 'aceProject/onAsyncCallHierarchy',
  'textDocument/prepareTypeHierarchy': 'aceProject/onAsyncTypeHierarchy',
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

// Ace falsely advertises these in its own capabilities but returns "Unhandled method" at runtime
const ACE_FALSE_CAPABILITIES = new Set([
  'colorProvider',
  'declarationProvider',
  'documentFormattingProvider',
  'documentRangeFormattingProvider',
  'linkedEditingRangeProvider',
]);

function addProxyCapabilities(result: unknown): unknown {
  if (!isPlainObject(result)) {
    return result;
  }

  const rawCaps = isPlainObject(result.capabilities) ? result.capabilities : {};
  // Strip ace's false capability claims
  const aceCaps: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawCaps)) {
    if (!ACE_FALSE_CAPABILITIES.has(key)) {
      aceCaps[key] = value;
    }
  }

  return {
    ...result,
    capabilities: {
      ...aceCaps,
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      renameProvider: { prepareProvider: true },
      codeActionProvider: true,
      implementationProvider: true,
      documentHighlightProvider: true,
      documentLinkProvider: true,
      callHierarchyProvider: true,
      typeHierarchyProvider: true,
      inlayHintProvider: true,
      foldingRangeProvider: true,
      selectionRangeProvider: true,
    },
  };
}

function createQueueToken(): string {
  return `arkts-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isWsl(): boolean {
  return process.platform === 'linux' && fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop');
}

function wslToLinuxPath(windowsStylePath: string): string {
  if (!isWsl()) return windowsStylePath;
  const m = windowsStylePath.match(/^\/([A-Za-z]):\/(.*)$/);
  if (m) {
    return `/mnt/${m[1].toLowerCase()}/${m[2]}`;
  }
  return windowsStylePath;
}

function uriToFilePath(uri: unknown): string | null {
  if (typeof uri !== 'string' || !uri.length) {
    return null;
  }
  if (uri.startsWith('file://')) {
    try {
      return wslToLinuxPath(fileURLToPath(uri));
    } catch {
      return null;
    }
  }
  return wslToLinuxPath(path.resolve(uri));
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

function getTextDocumentUri(params: RpcParams): string | null {
  const textDocument = extractTextDocument(params);
  return typeof textDocument?.uri === 'string' ? textDocument.uri : null;
}

interface StringFieldQuery { value: string; source: string }
function getStringField(value: unknown, keys: string[]): StringFieldQuery | null {
  if (!isPlainObject(value)) return null;
  for (const key of keys) {
    if (typeof (value as Record<string,unknown>)[key] === 'string') {
      return { value: (value as Record<string,unknown>)[key] as string, source: key };
    }
  }
  return null;
}

function extractWorkspaceSymbolQuery(params: RpcParams): { query: string; source: string; paramKeys: string[] } {
  const paramKeys = isPlainObject(params) ? Object.keys(params).sort() : [];
  const root = getStringField(params, ['query', 'name', 'symbol', 'pattern']);
  if (root) return { query: root.value.trim(), source: root.source, paramKeys };
  const nestedKeys = ['params', 'input', 'data', 'filter'];
  for (const key of nestedKeys) {
    const nested = isPlainObject(params) ? params[key] : undefined;
    const nestedQuery = getStringField(nested, ['query', 'name', 'symbol', 'pattern']);
    if (nestedQuery) return { query: nestedQuery.value.trim(), source: `${key}.${nestedQuery.source}`, paramKeys };
  }
  return { query: '', source: 'none', paramKeys };
}

function readFileText(uri: string): string | null {
  const filePath = uriToFilePath(uri);
  if (!filePath) return null;
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return null; }
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

function shouldLogMetadataDebug(): boolean {
  const value = String(process.env.ARKTS_LSP_METADATA_DEBUG ?? '').toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function shouldTraceLsp(): boolean {
  const value = String(process.env.ARKTS_LSP_TRACE ?? '').toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function traceLsp(message: string, fields?: Record<string, unknown>): void {
  if (!shouldTraceLsp()) {
    return;
  }

  const suffix = fields ? ` ${JSON.stringify(fields)}` : '';
  process.stderr.write(`[arkts-lsp trace] ${message}${suffix}\n`);
}

function pathExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function listExistingChildren(root: string, names: string[]): Record<string, boolean> {
  return Object.fromEntries(names.map((name) => [name, pathExists(path.join(root, name))]));
}

function logMetadataDebug(env: DevEcoEnv, project: ProjectConfig, rootHint: string | null, resolvedRoot: string): void {
  const dependencyMapPath = path.join(project.projectRoot, '.hvigor', 'dependencyMap', 'dependencyMap.json5');
  const payload = {
    rootHint,
    resolvedRoot,
    projectRoot: project.projectRoot,
    projectFiles: listExistingChildren(project.projectRoot, [
      'oh_modules',
      'oh-package.json5',
      'oh-package-lock.json5',
      'build-profile.json5',
      '.hvigor',
    ]),
    dependencyMapPath,
    dependencyMapPathExists: pathExists(dependencyMapPath),
    sdkPath: env.sdkPath,
    sdkChildren: listExistingChildren(env.sdkPath, ['ets', 'kits', 'js', 'api']),
    aceServerPath: env.aceServerPath,
    hvigorPath: env.hvigorPath,
    sdkPathExists: pathExists(env.sdkPath),
    aceServerPathExists: pathExists(env.aceServerPath),
    hvigorPathExists: pathExists(env.hvigorPath),
    modules: project.modules.map((module) => ({
      moduleName: module.moduleName,
      modulePath: module.modulePath,
      moduleType: module.moduleType,
      compileSdkVersion: module.compileSdkVersion,
      compatibleSdkVersion: module.compatibleSdkVersion,
      apiType: module.apiType,
      runtimeOs: module.runtimeOs,
      aceLoaderPath: module.aceLoaderPath,
      sdkJsPath: module.sdkJsPath,
      aceLoaderPathExists: pathExists(module.aceLoaderPath),
      sdkJsPathExists: pathExists(module.sdkJsPath),
      packageManagerType: module.packageManagerType,
    })),
  };

  process.stderr.write(`[arkts-lsp] metadata debug: ${JSON.stringify(payload)}\n`);
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
  const openDocumentTexts = new Map<string, string>();
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

  function createAceConnection(stdout: NodeJS.ReadableStream, stdin: NodeJS.WritableStream): MessageConnection {
    const conn = createMessageConnection(new StreamMessageReader(stdout), new StreamMessageWriter(stdin));

    conn.onNotification((method, params) => {
      if (completePendingAceRequest(method, params)) {
        return;
      }
      if (method === 'aceProject/onIndexingProgressUpdate') {
        // Like deveco-cli: indexing is in progress, log and continue waiting
        process.stderr.write('[arkts-lsp] ace indexing in progress...\n');
        return;
      }
      if (method === ACE_MODULE_INIT_METHOD) {
        if (isModuleInitSuccess(params)) {
          isServerReady = true;
          process.stderr.write('[arkts-lsp] ace module init complete\n');
          flushQueues();
        } else {
          // Init reported failure but ace may still service requests in degraded mode
          // (deveco-cli also accepts partial results after timeout)
          process.stderr.write('[arkts-lsp] ace module init reported failure, serving in degraded mode\n');
          isServerReady = true;
          flushQueues();
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

      if (shouldLogMetadataDebug()) {
        logMetadataDebug(env, parsed, rootHint, resolvedRoot);
      }

      scheduleHvigorSync(parsed.projectRoot);

      const handle = startAceServer(env, parsed.projectRoot);
      aceHandle = handle;
      const conn = createAceConnection(handle.filteredStdout, handle.process.stdin!);
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
      traceLsp('request route', { method: 'initialize', route: 'proxy-initialize' });
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
      return addProxyCapabilities(result);
    })().catch((err) => {
      isInitialized = false;
      clearQueues(err);
      throw err;
    }).finally(() => {
      initializePromise = null;
    });

    return initializePromise;
  }

  async function onRequest(method: string, params: RpcParams): Promise<RpcResult> {
    traceLsp('client request', {
      method,
      initialized: isInitialized,
      serverReady: isServerReady,
      hasAceConnection: Boolean(aceConn),
    });

    if (method === 'initialize') {
      return resolveInitializeRequest(params) as Promise<RpcResult>;
    }

    if (!isInitialized && !initializePromise) {
      return Promise.reject(new ResponseError(ErrorCodes.ServerNotInitialized, 'Initialize first.'));
    }

    // documentSymbol / workspaceSymbol: prefer ace, fallback to proxy parser
    if (method === 'textDocument/documentSymbol') {
      const uri = getTextDocumentUri(params);
      if (!uri) {
        traceLsp('request route', { method, route: 'proxy-fallback', reason: 'missing-uri' });
        return Promise.resolve([]);
      }
      if (aceConn && isServerReady) {
        const aceResult = await sendAceRequest(aceConn, method, createRequestPayload(params), false)
          .then((result) => normalizeClientResult(method, result))
          .catch(() => null);
        if (aceResult && Array.isArray(aceResult) && aceResult.length > 0) {
          traceLsp('request route', { method, route: 'ace-response', resultCount: aceResult.length });
          return aceResult;
        }
      }
      const text = openDocumentTexts.get(uri) ?? readFileText(uri);
      traceLsp('request route', { method, route: 'proxy-fallback', hasText: Boolean(text) });
      return Promise.resolve(text ? parseDocumentSymbols(text) : []);
    }

    if (method === 'workspace/symbol') {
      const { query } = extractWorkspaceSymbolQuery(params);
      if (aceConn && isServerReady) {
        const aceResult = await sendAceRequest(aceConn, method, createRequestPayload(params), false)
          .then((result) => normalizeClientResult(method, result))
          .catch(() => null);
        if (aceResult && Array.isArray(aceResult) && aceResult.length > 0) {
          traceLsp('request route', { method, route: 'ace-response', resultCount: aceResult.length });
          return aceResult;
        }
      }
      const symbols = project ? parseWorkspaceSymbols(project.projectRoot, query) : [];
      traceLsp('request route', { method, route: 'proxy-fallback', resultCount: symbols.length });
      return Promise.resolve(symbols);
    }

    // foldingRange / selectionRange: proxy-only fallback (ace does not handle these)
    if (method === 'textDocument/foldingRange') {
      const uri = getTextDocumentUri(params);
      const text = uri ? (openDocumentTexts.get(uri) ?? readFileText(uri)) : null;
      if (!text) {
        traceLsp('request route', { method, route: 'proxy-fallback', reason: 'no-text' });
        return Promise.resolve([]);
      }
      const ranges: Array<{ startLine: number; endLine: number; kind?: string }> = [];
      const lines = text.split(/\r?\n/);
      let depth = 0;
      const stack: Array<{ startLine: number; depth: number }> = [];
      for (let i = 0; i < lines.length; i += 1) {
        const masked = lines[i].replace(/(['"`])(?:(?!\1|\\)|\\.)*\1/g, '').replace(/\/\/.*/, '');
        for (const ch of masked) {
          if (ch === '{') {
            stack.push({ startLine: i, depth });
            depth += 1;
          } else if (ch === '}') {
            depth = Math.max(0, depth - 1);
            const top = stack.pop();
            if (top && top.depth === depth && i > top.startLine) {
              ranges.push({ startLine: top.startLine, endLine: i, kind: 'region' });
            }
          }
        }
      }
      traceLsp('request route', { method, route: 'proxy-fallback', resultCount: ranges.length });
      return Promise.resolve(ranges);
    }

    if (method === 'textDocument/selectionRange') {
      traceLsp('request route', { method, route: 'proxy-fallback' });
      const positions = (params && Array.isArray(params.positions) ? params.positions : []) as Array<{ line: number; character: number }>;
      const results = positions.map((pos) => ({
        range: { start: pos, end: pos },
        parent: null,
      }));
      return Promise.resolve(results);
    }

    const mapped = mapRequest(method, params, openFiles);
    const targetMethod = mapped?.method ?? method;
    const targetParams = mapped?.params ?? createRequestPayload(params);
    const useNotificationResponse = Boolean(mapped);
    traceLsp('request route', {
      method,
      route: mapped ? 'ace-notification' : 'ace-request-forward',
      targetMethod,
    });
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
    traceLsp('client notification', { method });

    if (method === 'textDocument/didOpen') {
      const textDocument = isPlainObject(params) ? (params.textDocument as Record<string, unknown>) : undefined;
      const uri = isPlainObject(textDocument) ? (textDocument.uri as string | undefined) : undefined;
      if (uri && typeof uri === 'string') {
        openFiles.add(uri);
        if (typeof textDocument?.text === 'string') {
          openDocumentTexts.set(uri, textDocument.text);
        }
      }
    }

    if (method === 'textDocument/didChange') {
      const textDocument = isPlainObject(params) ? (params.textDocument as Record<string, unknown>) : undefined;
      const uri = isPlainObject(textDocument) ? (textDocument.uri as string | undefined) : undefined;
      const contentChanges = isPlainObject(params) && Array.isArray(params.contentChanges) ? params.contentChanges : [];
      const lastChange = contentChanges[contentChanges.length - 1];
      if (uri && isPlainObject(lastChange) && typeof lastChange.text === 'string') {
        openDocumentTexts.set(uri, lastChange.text);
      }
    }

    if (method === 'textDocument/didClose') {
      const textDocument = isPlainObject(params) ? (params.textDocument as Record<string, unknown>) : undefined;
      const uri = isPlainObject(textDocument) ? (textDocument.uri as string | undefined) : undefined;
      if (uri && typeof uri === 'string') {
        openFiles.delete(uri);
        openDocumentTexts.delete(uri);
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
