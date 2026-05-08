import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { parseProject, extractCompatibleSdkLevel, findProjectRoot, type AceModule } from '../src/project';

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'sample-project');

describe('extractCompatibleSdkLevel', () => {
  it('extracts level from "5.0.0(12)"', () => {
    expect(extractCompatibleSdkLevel('5.0.0(12)')).toBe('12');
  });

  it('extracts level from "4.1.0(11)"', () => {
    expect(extractCompatibleSdkLevel('4.1.0(11)')).toBe('11');
  });

  it('returns "12" as fallback for unrecognized format', () => {
    expect(extractCompatibleSdkLevel('unknown')).toBe('12');
  });
});

describe('parseProject', () => {
  const mockSdkPath = '/mock/sdk/default';

  it('returns null when build-profile.json5 is missing', () => {
    expect(parseProject('/nonexistent', mockSdkPath)).toBeNull();
  });

  it('parses modules from build-profile.json5', () => {
    const result = parseProject(FIXTURE_DIR, mockSdkPath);
    expect(result).not.toBeNull();
    expect(result!.projectRoot).toBe(FIXTURE_DIR);
    expect(result!.modules).toHaveLength(1);
  });

  it('constructs AceModule with correct fields', () => {
    const result = parseProject(FIXTURE_DIR, mockSdkPath);
    const mod = result!.modules[0];

    expect(mod.moduleName).toBe('entry');
    expect(mod.modulePath).toBe(path.join(FIXTURE_DIR, 'entry'));
    expect(mod.deviceType).toEqual(['phone']);
    expect(mod.jsComponentType).toBe(0);
    expect(mod.compatibleSdkLevel).toBe('12');
    expect(mod.apiType).toBe('Stage');
    expect(mod.sdkJsPath).toContain('js/api/phone');
    expect(mod.aceLoaderPath).toContain('js/framework/phone/ace-loader');
  });

  it('uses rootUri format correctly', () => {
    const result = parseProject(FIXTURE_DIR, mockSdkPath);
    expect(result!.rootUri).toBe('file://' + FIXTURE_DIR);
  });
});

describe('findProjectRoot', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'findroot-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds project root in current directory', () => {
    fs.writeFileSync(path.join(tmpDir, 'build-profile.json5'), '{}');
    expect(findProjectRoot(tmpDir)).toBe(tmpDir);
  });

  it('finds project root in parent directory', () => {
    const sub = path.join(tmpDir, 'entry', 'src');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'build-profile.json5'), '{}');
    expect(findProjectRoot(sub)).toBe(tmpDir);
  });

  it('returns null when no build-profile.json5 found', () => {
    expect(findProjectRoot(tmpDir)).toBeNull();
  });
});
