import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node';
import type { ChildProcess } from 'child_process';
import type { AceModule } from './project';

export interface LspMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

export interface InitializationPayload {
  rootUri: string;
  lspServerWorkspacePath: string;
  modules: AceModule[];
}

export function injectInitializationOptions(
  message: LspMessage,
  payload: InitializationPayload,
): LspMessage {
  if (message.method === 'initialize' && message.params) {
    const params = { ...message.params };
    params.initializationOptions = {
      ...(params.initializationOptions || {}),
      rootUri: payload.rootUri,
      lspServerWorkspacePath: payload.lspServerWorkspacePath,
      modules: payload.modules,
    };
    return { ...message, params };
  }
  return message;
}

export interface ProxyHandle {
  dispose: () => void;
}

export function createProxy(
  clientIn: NodeJS.ReadableStream,
  clientOut: NodeJS.WritableStream,
  aceProcess: ChildProcess,
  payload: InitializationPayload,
): ProxyHandle {
  const aceIn = aceProcess.stdout;
  const aceOut = aceProcess.stdin;
  if (!aceIn || !aceOut) {
    throw new Error('aceProcess must have both stdout and stdin streams');
  }

  const clientConn: MessageConnection = createMessageConnection(
    new StreamMessageReader(clientIn),
    new StreamMessageWriter(clientOut),
  );

  const aceConn: MessageConnection = createMessageConnection(
    new StreamMessageReader(aceIn),
    new StreamMessageWriter(aceOut),
  );

  clientConn.onNotification((method, params) => {
    aceConn.sendNotification(method, params);
  });

  clientConn.onRequest((method, params, token) => {
    if (method === 'initialize') {
      const message = { method, params: params as Record<string, unknown> };
      const modified = injectInitializationOptions(message, payload);
      return aceConn.sendRequest(method, modified.params, token);
    }
    return aceConn.sendRequest(method, params, token);
  });

  aceConn.onNotification((method, params) => {
    clientConn.sendNotification(method, params);
  });

  aceConn.onRequest((method, params, token) => {
    return clientConn.sendRequest(method, params, token);
  });

  aceConn.onError(([err]) => {
    process.stderr.write(`[arkts-lsp] ace connection error: ${err.message}\n`);
    clientConn.dispose();
  });

  clientConn.onError(([err]) => {
    process.stderr.write(`[arkts-lsp] client connection error: ${err.message}\n`);
    aceConn.dispose();
  });

  aceProcess.on('exit', () => {
    clientConn.dispose();
  });

  clientConn.listen();
  aceConn.listen();

  return {
    dispose: () => {
      clientConn.dispose();
      aceConn.dispose();
    },
  };
}
