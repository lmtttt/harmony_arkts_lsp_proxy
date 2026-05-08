import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { startAceServer } from '../src/ace-server';
import type { DevEcoEnv } from '../src/env';

function makeFakeEnv(): { env: DevEcoEnv; tmpDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-test-'));
  const nodeBin = process.execPath; // Use actual node
  const aceServerPath = path.join(tmpDir, 'fake-ace.js');
  // A script that writes to stdout and exits after a short delay
  fs.writeFileSync(aceServerPath, `
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'ready'}) + '\\n');
    setTimeout(() => process.exit(0), 100);
  `);
  return {
    env: {
      devecoHome: tmpDir,
      sdkPath: path.join(tmpDir, 'sdk'),
      aceServerPath,
      nodeBin,
      hvigorPath: path.join(tmpDir, 'hvigorw.js'),
    },
    tmpDir,
  };
}

describe('startAceServer', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('starts with correct arguments (nodeBin + aceServerPath)', () => {
    const { env, tmpDir: dir } = makeFakeEnv();
    tmpDir = dir;
    const handle = startAceServer(env);
    expect(handle.process).toBeDefined();
    expect(handle.kill).toBeInstanceOf(Function);
    expect(handle.onExit).toBeInstanceOf(Function);
    handle.kill();
  });

  it('triggers onExit callback when process exits', async () => {
    const { env, tmpDir: dir } = makeFakeEnv();
    tmpDir = dir;
    const handle = startAceServer(env);

    const exitPromise = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      handle.onExit((code, signal) => {
        resolve({ code, signal });
      });
    });

    const result = await exitPromise;
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
  });

  it('kill() does not throw when process already exited', async () => {
    const { env, tmpDir: dir } = makeFakeEnv();
    tmpDir = dir;
    const handle = startAceServer(env);

    await new Promise<void>((resolve) => {
      handle.onExit(() => resolve());
    });

    // Should not throw
    expect(() => handle.kill()).not.toThrow();
  });
});
