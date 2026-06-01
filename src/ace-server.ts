import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DevEcoEnv } from './env';
import { toWindowsPath } from './env';

export type ExitHandler = (code: number | null, signal: string | null) => void;

export interface AceServerHandle {
  process: ChildProcess;
  kill: () => void;
  onExit: (handler: ExitHandler) => void;
  dispose: () => void;
}

function createLogDir(): string {
  const baseDir = process.env.ARKTS_LSP_LOG_DIR || path.join(os.tmpdir(), 'arkts-lsp-proxy');
  const logDir = path.join(baseDir, Date.now().toString());
  fs.mkdirSync(logDir, { recursive: true });
  return logDir;
}

export function startAceServer(env: DevEcoEnv): AceServerHandle {
  process.stderr.write(`[arkts-lsp] Starting ace-server (stdio): ${env.aceServerPath}\n`);
  const logDir = createLogDir();
  process.stderr.write(`[arkts-lsp] ace-server logs: ${logDir}\n`);

  // On WSL: executable + cwd stay as WSL paths; arguments must be Windows paths
  const aceServerPath = toWindowsPath(env.aceServerPath);

  const child = spawn(env.nodeBin, [
    '--max-old-space-size=8192',
    '--expose-gc',
    aceServerPath,
    '--stdio',
    `--logger-path=${logDir}`,
    '--logger-level=INFO',
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    cwd: env.devecoHome,
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
    dispose: () => {
      if (child.exitCode === null) {
        child.kill();
      }
    },
  };
}
