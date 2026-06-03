import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Transform } from 'node:stream';
import type { DevEcoEnv } from './env';
import { toWindowsPath } from './env';

export type ExitHandler = (code: number | null, signal: string | null) => void;

export interface AceServerHandle {
  process: ChildProcess;
  filteredStdout: NodeJS.ReadableStream;
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

function createAceStdoutFilter(): Transform {
  let buffer = '';
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      buffer += chunk.toString('utf8');
      // Pass through only valid Content-Length-prefixed LSP messages;
      // strip raw log lines that ace-server worker sometimes writes to stdout
      while (true) {
        const headerMatch = buffer.match(/^Content-Length: (\d+)\r\n\r\n/);
        if (!headerMatch) {
          const newlineIdx = buffer.indexOf('\n');
          if (newlineIdx >= 0) {
            // Skip this non-LSP line
            const skipped = buffer.slice(0, newlineIdx + 1);
            buffer = buffer.slice(newlineIdx + 1);
            process.stderr.write(`[ace-stdout-filter] skipped: ${skipped.trim().slice(0, 200)}\n`);
            continue;
          }
          break;
        }
        const contentLength = parseInt(headerMatch[1], 10);
        const headerEnd = headerMatch[0].length;
        if (buffer.length < headerEnd + contentLength) break;
        const message = buffer.slice(0, headerEnd + contentLength);
        buffer = buffer.slice(headerEnd + contentLength);
        this.push(Buffer.from(message, 'utf8'));
      }
      callback();
    },
  });
}

export function startAceServer(env: DevEcoEnv, projectRoot: string): AceServerHandle {
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
    cwd: projectRoot,
    env: {
      ...process.env,
      DEVECO_SDK_HOME: env.sdkPath,
    },
  });

  // Filter stdout to strip non-LSP log output from ace-server worker
  const stdoutFilter = createAceStdoutFilter();
  const filteredStdout = child.stdout ? child.stdout.pipe(stdoutFilter) : child.stdout;

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
    filteredStdout: filteredStdout || child.stdout!,
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
