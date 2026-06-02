import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  getHvigorMetadataState,
  parseHvigorSyncConfig,
  runHvigorSync,
  runHvigorSyncAsync,
  type HvigorSyncConfig,
} from '../src/hvigor';
import type { DevEcoEnv } from '../src/env';

const FRESH_AGE_MS = 24 * 60 * 60 * 1000;

function makeFakeEnv(overrides?: Partial<DevEcoEnv>, nodeScript = '#!/bin/sh\nexit 0\n'): DevEcoEnv {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hvigor-env-'));
  const nodeBin = path.join(tmpDir, 'node');
  const hvigorPath = path.join(tmpDir, 'hvigorw.js');
  fs.writeFileSync(nodeBin, nodeScript);
  fs.chmodSync(nodeBin, 0o755);
  fs.writeFileSync(hvigorPath, '// hvigor');
  return {
    devecoHome: tmpDir,
    sdkPath: path.join(tmpDir, 'sdk'),
    aceServerPath: path.join(tmpDir, 'ace-server'),
    nodeBin,
    hvigorPath,
    ...overrides,
  };
}

function writeDependencyMap(projectRoot: string, ageMs = 0): string {
  const depMapDir = path.join(projectRoot, '.hvigor', 'dependencyMap');
  fs.mkdirSync(depMapDir, { recursive: true });
  const depMapFile = path.join(depMapDir, 'dependencyMap.json5');
  fs.writeFileSync(depMapFile, '{}');
  if (ageMs > 0) {
    const old = new Date(Date.now() - ageMs);
    fs.utimesSync(depMapFile, old, old);
  }
  return depMapFile;
}

function syncConfig(overrides?: Partial<HvigorSyncConfig>): HvigorSyncConfig {
  return {
    mode: 'auto',
    timeoutMs: 15_000,
    metadataMaxAgeMs: FRESH_AGE_MS,
    ...overrides,
  };
}

describe('hvigor sync helpers', () => {
  let tmpDir: string;
  const envDirs: string[] = [];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hvigor-test-project-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const d of envDirs) {
      fs.rmSync(d, { recursive: true, force: true });
    }
    envDirs.length = 0;
  });

  it('returns missing when dependency map does not exist', () => {
    expect(getHvigorMetadataState(tmpDir, FRESH_AGE_MS)).toMatchObject({
      state: 'missing',
      dependencyMapPath: path.join(tmpDir, '.hvigor', 'dependencyMap', 'dependencyMap.json5'),
    });
  });

  it('returns fresh when dependency map is within max age', () => {
    writeDependencyMap(tmpDir);
    expect(getHvigorMetadataState(tmpDir, FRESH_AGE_MS).state).toBe('fresh');
  });

  it('returns stale when dependency map is older than max age', () => {
    writeDependencyMap(tmpDir, 2 * FRESH_AGE_MS);
    expect(getHvigorMetadataState(tmpDir, FRESH_AGE_MS).state).toBe('stale');
  });

  it('parses sync config defaults and overrides', () => {
    expect(parseHvigorSyncConfig({})).toEqual({
      mode: 'auto',
      timeoutMs: 15_000,
      metadataMaxAgeMs: FRESH_AGE_MS,
    });
    expect(parseHvigorSyncConfig({ ARKTS_LSP_SYNC: 'off' }).mode).toBe('off');
    expect(parseHvigorSyncConfig({ ARKTS_LSP_SYNC: 'auto' }).mode).toBe('auto');
    expect(parseHvigorSyncConfig({ ARKTS_LSP_SYNC: 'force' }).mode).toBe('force');
    expect(parseHvigorSyncConfig({ ARKTS_LSP_SYNC: 'bad' }).mode).toBe('auto');
    expect(parseHvigorSyncConfig({ ARKTS_LSP_SYNC_TIMEOUT_MS: '30000' }).timeoutMs).toBe(30_000);
    expect(parseHvigorSyncConfig({ ARKTS_LSP_SYNC_TIMEOUT_MS: '-1' }).timeoutMs).toBe(15_000);
  });

  it('skips async sync when mode is off', async () => {
    const env = makeFakeEnv();
    envDirs.push(env.devecoHome);

    const result = await runHvigorSyncAsync(env, tmpDir, syncConfig({ mode: 'off' }));

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('disabled');
    expect(result.metadataBefore.state).toBe('missing');
  });

  it('skips async auto sync when dependency map is fresh', async () => {
    writeDependencyMap(tmpDir);
    const env = makeFakeEnv();
    envDirs.push(env.devecoHome);

    const result = await runHvigorSyncAsync(env, tmpDir, syncConfig());

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('fresh');
    expect(result.metadataBefore.state).toBe('fresh');
  });

  it('runs async sync when dependency map is stale', async () => {
    writeDependencyMap(tmpDir, 2 * FRESH_AGE_MS);
    const env = makeFakeEnv();
    envDirs.push(env.devecoHome);

    const result = await runHvigorSyncAsync(env, tmpDir, syncConfig());

    expect(result.status).toBe('completed');
    expect(result.metadataBefore.state).toBe('stale');
  });

  it('returns failed when async sync tools are missing', async () => {
    const env = makeFakeEnv({ nodeBin: '/nonexistent/node' });
    envDirs.push(env.devecoHome);

    const result = await runHvigorSyncAsync(env, tmpDir, syncConfig({ mode: 'force' }));

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('missing-tools');
    expect(result.errorMessage).toContain('DevEco node not found');
  });

  it('returns failed when async sync exits non-zero', async () => {
    const env = makeFakeEnv(undefined, '#!/bin/sh\necho bad >&2\nexit 2\n');
    envDirs.push(env.devecoHome);

    const result = await runHvigorSyncAsync(env, tmpDir, syncConfig({ mode: 'force' }));

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('exit-code');
    expect(result.exitCode).toBe(2);
    expect(result.errorMessage).toContain('bad');
  });

  it('returns timeout when async sync exceeds timeout', async () => {
    const env = makeFakeEnv(undefined, '#!/bin/sh\nsleep 2\nexit 0\n');
    envDirs.push(env.devecoHome);

    const result = await runHvigorSyncAsync(env, tmpDir, syncConfig({ mode: 'force', timeoutMs: 50 }));

    expect(result.status).toBe('timeout');
    expect(result.errorMessage).toContain('timed out');
  });

  it('keeps the legacy blocking wrapper behavior for existing callers', () => {
    const env = makeFakeEnv();
    envDirs.push(env.devecoHome);

    expect(runHvigorSync(env, tmpDir)).toBe(true);
  });
});
