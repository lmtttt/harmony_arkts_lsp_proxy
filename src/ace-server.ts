import { spawn, type ChildProcess } from 'child_process';
import type { DevEcoEnv } from './env';

export type ExitHandler = (code: number | null, signal: string | null) => void;

export interface AceServerHandle {
  process: ChildProcess;
  kill: () => void;
  onExit: (handler: ExitHandler) => void;
}

export function startAceServer(env: DevEcoEnv): AceServerHandle {
  process.stderr.write(`[arkts-lsp] Starting ace-server: ${env.aceServerPath}\n`);

  const child = spawn(env.nodeBin, [env.aceServerPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      DEVECO_SDK_HOME: env.sdkPath,
    },
  });

  const exitHandlers: ExitHandler[] = [];

  child.stderr?.on('data', (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg && !msg.includes('heartbeat')) {
      process.stderr.write(`[ace-server] ${msg}\n`);
    }
  });

  child.on('error', (err) => {
    process.stderr.write(`[arkts-lsp] ace-server error: ${err.message}\n`);
    for (const handler of exitHandlers) {
      handler(1, null);
    }
  });

  child.on('exit', (code, signal) => {
    process.stderr.write(`[arkts-lsp] ace-server exited (code=${code}, signal=${signal})\n`);
    for (const handler of exitHandlers) {
      handler(code, signal);
    }
  });

  return {
    process: child,
    kill: () => {
      if (child.exitCode === null) {
        child.kill();
      }
    },
    onExit: (handler: ExitHandler) => {
      exitHandlers.push(handler);
    },
  };
}
