import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { findDevEcoEnv, type DevEcoEnv } from '../src/env';

describe('findDevEcoEnv', () => {
  const tmpDir = path.join(os.tmpdir(), 'arkts-lsp-test-env-' + Date.now());

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.DEVECO_HOME;
  });

  function createFakeDevEco(baseDir: string): string {
    const contentsDir = path.join(baseDir, 'Contents');
    const aceDir = path.join(contentsDir, 'plugins', 'openharmony', 'ace-server', 'out');
    const sdkDir = path.join(contentsDir, 'sdk', 'default');
    const nodeDir = path.join(contentsDir, 'tools', 'node', 'bin');
    const hvigorDir = path.join(contentsDir, 'tools', 'hvigor', 'bin');

    fs.mkdirSync(aceDir, { recursive: true });
    fs.mkdirSync(sdkDir, { recursive: true });
    fs.mkdirSync(nodeDir, { recursive: true });
    fs.mkdirSync(hvigorDir, { recursive: true });

    fs.writeFileSync(path.join(aceDir, 'index.js'), '// ace-server');
    fs.writeFileSync(path.join(sdkDir, 'sdk-pkg.json'), '{}');
    fs.writeFileSync(path.join(nodeDir, 'node'), '#!/bin/sh');
    fs.writeFileSync(path.join(hvigorDir, 'hvigorw.js'), '// hvigor');

    return contentsDir;
  }

  it('returns null when DevEco is not found', () => {
    process.env.DEVECO_HOME = '/nonexistent/path';
    expect(findDevEcoEnv()).toBeNull();
  });

  it('finds DevEco from DEVECO_HOME env var (macOS .app path)', () => {
    const fakeApp = path.join(tmpDir, 'DevEco-Studio.app');
    createFakeDevEco(fakeApp);
    process.env.DEVECO_HOME = fakeApp;

    const env = findDevEcoEnv();
    expect(env).not.toBeNull();
    expect(env!.devecoHome).toBe(path.join(fakeApp, 'Contents'));
    expect(env!.aceServerPath).toContain('ace-server/out/index.js');
    expect(env!.sdkPath).toContain('sdk/default');
    expect(env!.nodeBin).toContain('tools/node/bin/node');
    expect(env!.hvigorPath).toContain('tools/hvigor/bin/hvigorw.js');
  });

  it('finds DevEco from DEVECO_HOME when already inside Contents', () => {
    const fakeApp = path.join(tmpDir, 'DevEco-Studio.app');
    const contentsDir = createFakeDevEco(fakeApp);
    process.env.DEVECO_HOME = contentsDir;

    const env = findDevEcoEnv();
    expect(env).not.toBeNull();
    expect(env!.devecoHome).toBe(contentsDir);
  });

  it('returns null when ace-server is missing', () => {
    const incomplete = path.join(tmpDir, 'Incomplete.app');
    fs.mkdirSync(path.join(incomplete, 'Contents'), { recursive: true });
    process.env.DEVECO_HOME = incomplete;

    expect(findDevEcoEnv()).toBeNull();
  });
});
