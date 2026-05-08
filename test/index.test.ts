import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock all dependencies before any imports
vi.mock('../src/env');
vi.mock('../src/project');
vi.mock('../src/hvigor');
vi.mock('../src/ace-server');
vi.mock('../src/proxy');

import { findDevEcoEnv } from '../src/env';
import { parseProject } from '../src/project';
import { runHvigorSync } from '../src/hvigor';
import { startAceServer } from '../src/ace-server';
import { createProxy } from '../src/proxy';

const mockFindDevEcoEnv = vi.mocked(findDevEcoEnv);
const mockParseProject = vi.mocked(parseProject);
const mockRunHvigorSync = vi.mocked(runHvigorSync);
const mockStartAceServer = vi.mocked(startAceServer);
const mockCreateProxy = vi.mocked(createProxy);

describe('index.ts integration', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // Default mocks for successful flow
    mockFindDevEcoEnv.mockReturnValue({
      devecoHome: '/fake/deveco',
      sdkPath: '/fake/sdk',
      aceServerPath: '/fake/ace',
      nodeBin: '/fake/node',
      hvigorPath: '/fake/hvigor',
    });
    mockParseProject.mockReturnValue({
      projectRoot: '/fake/project',
      rootUri: 'file:///fake/project',
      lspServerWorkspacePath: '/fake/project',
      modules: [],
    });
    mockRunHvigorSync.mockReturnValue(true);
    mockStartAceServer.mockReturnValue({
      process: { on: vi.fn(), stdout: null, stdin: null } as any,
      kill: vi.fn(),
      onExit: vi.fn(),
    });
    mockCreateProxy.mockReturnValue({ dispose: vi.fn() });
  });

  afterEach(() => {
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

  it('exits with code 1 when project is not found', async () => {
    mockParseProject.mockReturnValue(null);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as any);
    await expect(import('../src/index')).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('continues when hvigor sync fails', async () => {
    mockRunHvigorSync.mockReturnValue(false);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await import('../src/index');
    expect(mockStartAceServer).toHaveBeenCalled();
    expect(mockCreateProxy).toHaveBeenCalled();
  });
});
