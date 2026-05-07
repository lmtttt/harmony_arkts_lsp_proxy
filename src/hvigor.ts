import * as path from 'path';
import * as fs from 'fs';
import { spawnSync } from 'child_process';
import type { DevEcoEnv } from './env';

const HVIGOR_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

const HVIGOR_FLAGS = [
  '--sync',
  '-p', 'product=default',
  '--analyze=normal',
  '--parallel',
  '--incremental',
  '-p', 'enforce-ohpm=true',
  '--daemonjs',
];

function isSyncFresh(projectRoot: string): boolean {
  const depMap = path.join(projectRoot, '.hvigor', 'dependencyMap', 'dependencyMap.json5');
  if (!fs.existsSync(depMap)) return false;

  try {
    const stat = fs.statSync(depMap);
    const ageMs = Date.now() - stat.mtimeMs;
    return ageMs < 24 * 60 * 60 * 1000; // fresh if less than 24 hours old
  } catch {
    return false;
  }
}

export function runHvigorSync(env: DevEcoEnv, projectRoot: string): boolean {
  if (isSyncFresh(projectRoot)) {
    process.stderr.write('[arkts-lsp] hvigor sync skipped (dependency map is fresh)\n');
    return true;
  }

  if (!fs.existsSync(env.nodeBin)) {
    process.stderr.write(`[arkts-lsp] DevEco node not found at: ${env.nodeBin}\n`);
    return false;
  }
  if (!fs.existsSync(env.hvigorPath)) {
    process.stderr.write(`[arkts-lsp] hvigorw.js not found at: ${env.hvigorPath}\n`);
    return false;
  }

  process.stderr.write('[arkts-lsp] hvigor sync starting...\n');
  const startTime = Date.now();

  const result = spawnSync(env.nodeBin, [env.hvigorPath, ...HVIGOR_FLAGS], {
    cwd: projectRoot,
    timeout: HVIGOR_TIMEOUT_MS,
    windowsHide: true,
    encoding: 'utf8',
    env: {
      ...process.env,
      DEVECO_SDK_HOME: env.sdkPath,
    },
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  if (result.error) {
    if ((result.error as any).code === 'ETIMEDOUT') {
      process.stderr.write(`[arkts-lsp] hvigor sync timed out after ${HVIGOR_TIMEOUT_MS / 1000}s\n`);
      return false;
    }
    process.stderr.write(`[arkts-lsp] hvigor sync error: ${result.error.message}\n`);
    return false;
  }

  if (result.status !== 0) {
    process.stderr.write(`[arkts-lsp] hvigor sync failed (exit ${result.status}, ${elapsed}s)\n`);
    if (result.stderr) process.stderr.write(result.stderr.slice(-500) + '\n');
    return false;
  }

  process.stderr.write(`[arkts-lsp] hvigor sync completed (${elapsed}s)\n`);
  return true;
}
