import { spawn, type ChildProcess } from 'child_process';
import type { DevEcoEnv } from './env';

export interface AceServerHandle {
  process: ChildProcess;
  kill: () => void;
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

  child.stderr?.on('data', (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg && !msg.includes('heartbeat')) {
      process.stderr.write(`[ace-server] ${msg}\n`);
    }
  });

  child.on('error', (err) => {
    process.stderr.write(`[arkts-lsp] ace-server error: ${err.message}\n`);
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    process.stderr.write(`[arkts-lsp] ace-server exited (code=${code}, signal=${signal})\n`);
    process.exit(code ?? 1);
  });

  return {
    process: child,
    kill: () => {
      if (child.exitCode === null) {
        child.kill();
      }
    },
  };
}
