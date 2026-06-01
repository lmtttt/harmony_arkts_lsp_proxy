import * as path from 'path';
import * as fs from 'fs';
import { spawn, spawnSync } from 'child_process';
import type { DevEcoEnv } from './env';
import { toWindowsPath } from './env';

export type HvigorMetadataStateName = 'fresh' | 'stale' | 'missing';
export type HvigorSyncMode = 'auto' | 'off' | 'force';
export type HvigorSyncStatus = 'skipped' | 'completed' | 'failed' | 'timeout';

export interface HvigorMetadataState {
  state: HvigorMetadataStateName;
  dependencyMapPath: string;
  ageMs?: number;
}

export interface HvigorSyncConfig {
  mode: HvigorSyncMode;
  timeoutMs: number;
  metadataMaxAgeMs: number;
}

export interface HvigorSyncResult {
  status: HvigorSyncStatus;
  reason?: 'disabled' | 'fresh' | 'missing-tools' | 'exit-code' | 'spawn-error';
  metadataBefore: HvigorMetadataState;
  metadataAfter?: HvigorMetadataState;
  elapsedMs: number;
  exitCode?: number | null;
  errorMessage?: string;
}

const DEFAULT_METADATA_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SYNC_TIMEOUT_MS = 15_000;
const LEGACY_HVIGOR_TIMEOUT_MS = 10 * 60 * 1000;

const HVIGOR_FLAGS = [
  '--sync',
  '-p', 'product=default',
  '--analyze=normal',
  '--parallel',
  '--incremental',
  '-p', 'enforce-ohpm=true',
  '--daemonjs',
];

function getDependencyMapPath(projectRoot: string): string {
  return path.join(projectRoot, '.hvigor', 'dependencyMap', 'dependencyMap.json5');
}

export function getHvigorMetadataState(
  projectRoot: string,
  maxAgeMs = DEFAULT_METADATA_MAX_AGE_MS,
): HvigorMetadataState {
  const dependencyMapPath = getDependencyMapPath(projectRoot);
  if (!fs.existsSync(dependencyMapPath)) {
    return { state: 'missing', dependencyMapPath };
  }

  try {
    const stat = fs.statSync(dependencyMapPath);
    const ageMs = Date.now() - stat.mtimeMs;
    return {
      state: ageMs < maxAgeMs ? 'fresh' : 'stale',
      dependencyMapPath,
      ageMs,
    };
  } catch {
    return { state: 'missing', dependencyMapPath };
  }
}

export function parseHvigorSyncConfig(env: NodeJS.ProcessEnv = process.env): HvigorSyncConfig {
  const rawMode = env.ARKTS_LSP_SYNC;
  const mode: HvigorSyncMode = rawMode === 'off' || rawMode === 'force' || rawMode === 'auto' ? rawMode : 'auto';

  const parsedTimeout = Number(env.ARKTS_LSP_SYNC_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : DEFAULT_SYNC_TIMEOUT_MS;

  return {
    mode,
    timeoutMs,
    metadataMaxAgeMs: DEFAULT_METADATA_MAX_AGE_MS,
  };
}

function getMissingToolsMessage(env: DevEcoEnv): string | null {
  if (!fs.existsSync(env.nodeBin)) {
    return `DevEco node not found at: ${env.nodeBin}`;
  }
  if (!fs.existsSync(env.hvigorPath)) {
    return `hvigorw.js not found at: ${env.hvigorPath}`;
  }
  return null;
}

export async function runHvigorSyncAsync(
  env: DevEcoEnv,
  projectRoot: string,
  config = parseHvigorSyncConfig(),
): Promise<HvigorSyncResult> {
  const startTime = Date.now();
  const metadataBefore = getHvigorMetadataState(projectRoot, config.metadataMaxAgeMs);

  if (config.mode === 'off') {
    return { status: 'skipped', reason: 'disabled', metadataBefore, elapsedMs: 0 };
  }

  if (config.mode === 'auto' && metadataBefore.state === 'fresh') {
    return { status: 'skipped', reason: 'fresh', metadataBefore, elapsedMs: 0 };
  }

  const missingToolsMessage = getMissingToolsMessage(env);
  if (missingToolsMessage) {
    return {
      status: 'failed',
      reason: 'missing-tools',
      metadataBefore,
      elapsedMs: Date.now() - startTime,
      errorMessage: missingToolsMessage,
    };
  }

  return new Promise((resolve) => {
    let settled = false;
    let stderr = '';
    // On WSL: executable + cwd stay as WSL paths; arguments must be Windows paths
    const child = spawn(env.nodeBin, [toWindowsPath(env.hvigorPath), ...HVIGOR_FLAGS], {
      cwd: projectRoot,
      windowsHide: true,
      env: {
        ...process.env,
        DEVECO_SDK_HOME: toWindowsPath(env.sdkPath),
      },
    });

    function finish(result: Omit<HvigorSyncResult, 'metadataBefore' | 'elapsedMs'>): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        ...result,
        metadataBefore,
        elapsedMs: Date.now() - startTime,
      });
    }

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({
        status: 'timeout',
        metadataAfter: getHvigorMetadataState(projectRoot, config.metadataMaxAgeMs),
        errorMessage: `hvigor sync timed out after ${config.timeoutMs}ms`,
      });
    }, config.timeoutMs);

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      finish({
        status: 'failed',
        reason: 'spawn-error',
        metadataAfter: getHvigorMetadataState(projectRoot, config.metadataMaxAgeMs),
        errorMessage: error.message,
      });
    });

    child.on('exit', (code) => {
      const metadataAfter = getHvigorMetadataState(projectRoot, config.metadataMaxAgeMs);
      if (code === 0) {
        finish({ status: 'completed', metadataAfter, exitCode: code });
        return;
      }
      finish({
        status: 'failed',
        reason: 'exit-code',
        metadataAfter,
        exitCode: code,
        errorMessage: stderr.slice(-500),
      });
    });
  });
}

export function runHvigorSync(env: DevEcoEnv, projectRoot: string): boolean {
  const metadata = getHvigorMetadataState(projectRoot);
  if (metadata.state === 'fresh') {
    process.stderr.write('[arkts-lsp] hvigor sync skipped (dependency map is fresh)\n');
    return true;
  }

  const missingToolsMessage = getMissingToolsMessage(env);
  if (missingToolsMessage) {
    process.stderr.write(`[arkts-lsp] ${missingToolsMessage}\n`);
    return false;
  }

  process.stderr.write('[arkts-lsp] hvigor sync starting...\n');
  const startTime = Date.now();
  // On WSL: executable + cwd stay as WSL paths; arguments must be Windows paths
  const result = spawnSync(env.nodeBin, [toWindowsPath(env.hvigorPath), ...HVIGOR_FLAGS], {
    cwd: projectRoot,
    timeout: LEGACY_HVIGOR_TIMEOUT_MS,
    windowsHide: true,
    encoding: 'utf8',
    env: {
      ...process.env,
      DEVECO_SDK_HOME: toWindowsPath(env.sdkPath),
    },
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  if (result.error) {
    if ((result.error as any).code === 'ETIMEDOUT') {
      process.stderr.write(`[arkts-lsp] hvigor sync timed out after ${LEGACY_HVIGOR_TIMEOUT_MS / 1000}s\n`);
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
