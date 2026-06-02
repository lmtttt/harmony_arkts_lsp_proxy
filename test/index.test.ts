import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock all dependencies before any imports
vi.mock('../src/env');
vi.mock('../src/project');
vi.mock('../src/hvigor');
vi.mock('../src/ace-server');
vi.mock('../src/proxy');

import { findDevEcoEnv } from '../src/env';
import { createProxy } from '../src/proxy';

const mockFindDevEcoEnv = vi.mocked(findDevEcoEnv);
const mockCreateProxy = vi.mocked(createProxy);

describe('index.ts integration', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let originalArgv: string[];

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    originalArgv = process.argv;
    process.argv = ['node', 'dist/index.js'];
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // Default mocks for successful flow
    mockFindDevEcoEnv.mockReturnValue({
      devecoHome: '/fake/deveco',
      sdkPath: '/fake/sdk',
      aceServerPath: '/fake/ace',
      nodeBin: '/fake/node',
      hvigorPath: '/fake/hvigor',
    });
    mockCreateProxy.mockReturnValue({ dispose: vi.fn() });
  });

  afterEach(() => {
    process.argv = originalArgv;
    exitSpy?.mockRestore();
    stderrSpy.mockRestore();
  });

  it('exits with code 1 when DevEco is not found', async () => {
    mockFindDevEcoEnv.mockReturnValue(null);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as any);
    await expect(import('../src/index')).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('creates the proxy when DevEco is found', async () => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await import('../src/index');
    expect(mockCreateProxy).toHaveBeenCalled();
  });

  it('passes --project-root to the proxy', async () => {
    process.argv = ['node', 'dist/index.js', '--project-root', '/fake/project'];
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await import('../src/index');

    expect(mockCreateProxy).toHaveBeenCalledWith(
      process.stdin,
      process.stdout,
      expect.objectContaining({ devecoHome: '/fake/deveco' }),
      expect.objectContaining({ projectRootHint: '/fake/project' }),
    );
  });
});
