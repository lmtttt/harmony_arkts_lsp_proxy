import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { runHvigorSync } from '../src/hvigor';
import type { DevEcoEnv } from '../src/env';

function makeFakeEnv(overrides?: Partial<DevEcoEnv>): DevEcoEnv {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hvigor-env-'));
  const nodeBin = path.join(tmpDir, 'node');
  const hvigorPath = path.join(tmpDir, 'hvigorw.js');
  fs.writeFileSync(nodeBin, '#!/bin/sh\nexit 0');
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

describe('runHvigorSync', () => {
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

  it('skips sync when dependency map is fresh (< 24h)', () => {
    const depMapDir = path.join(tmpDir, '.hvigor', 'dependencyMap');
    fs.mkdirSync(depMapDir, { recursive: true });
    fs.writeFileSync(path.join(depMapDir, 'dependencyMap.json5'), '{}');

    const env = makeFakeEnv();
    envDirs.push(env.devecoHome);
    const result = runHvigorSync(env, tmpDir);
    expect(result).toBe(true);
  });

  it('runs sync when dependency map is stale (> 24h)', () => {
    const depMapDir = path.join(tmpDir, '.hvigor', 'dependencyMap');
    fs.mkdirSync(depMapDir, { recursive: true });
    const depMapFile = path.join(depMapDir, 'dependencyMap.json5');
    fs.writeFileSync(depMapFile, '{}');
    // Set mtime to 2 days ago
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    fs.utimesSync(depMapFile, twoDaysAgo, twoDaysAgo);

    const env = makeFakeEnv();
    envDirs.push(env.devecoHome);
    const result = runHvigorSync(env, tmpDir);
    // The fake node script exits 0, so sync should succeed
    expect(result).toBe(true);
  });

  it('returns false when nodeBin does not exist', () => {
    const env = makeFakeEnv({ nodeBin: '/nonexistent/node' });
    envDirs.push(env.devecoHome);
    const result = runHvigorSync(env, tmpDir);
    expect(result).toBe(false);
  });

  it('returns false when hvigorPath does not exist', () => {
    const env = makeFakeEnv({ hvigorPath: '/nonexistent/hvigorw.js' });
    envDirs.push(env.devecoHome);
    const result = runHvigorSync(env, tmpDir);
    expect(result).toBe(false);
  });
});
