import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node';
import type { ChildProcess } from 'child_process';
import type { AceModule } from './project';

export interface InitializationPayload {
  rootUri: string;
  lspServerWorkspacePath: string;
  modules: AceModule[];
}

export function injectInitializationOptions(
  message: any,
  payload: InitializationPayload,
): any {
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

export function createProxy(
  clientIn: NodeJS.ReadableStream,
  clientOut: NodeJS.WritableStream,
  aceProcess: ChildProcess,
  payload: InitializationPayload,
): void {
  const clientConn: MessageConnection = createMessageConnection(
    new StreamMessageReader(clientIn),
    new StreamMessageWriter(clientOut),
  );

  const aceIn = aceProcess.stdout!;
  const aceOut = aceProcess.stdin!;
  const aceConn: MessageConnection = createMessageConnection(
    new StreamMessageReader(aceIn),
    new StreamMessageWriter(aceOut),
  );

  clientConn.onNotification((method, params) => {
    aceConn.sendNotification(method, params);
  });

  clientConn.onRequest((method, params, token) => {
    if (method === 'initialize') {
      const original = { jsonrpc: '2.0', id: 0, method, params };
      const modified = injectInitializationOptions(original, payload);
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

  clientConn.listen();
  aceConn.listen();
}
