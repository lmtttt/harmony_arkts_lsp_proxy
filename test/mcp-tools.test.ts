import { describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { createArktsMcpService } from '../src/mcp-tools';

const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'sample-project');
const CAMERA_PAGE = path.join(FIXTURE_DIR, 'entry', 'src', 'main', 'ets', 'pages', 'CameraPage.ets');

describe('ArkTS MCP service', () => {
  it('returns project information from a HarmonyOS project root', async () => {
    const service = createArktsMcpService();

    const result = await service.projectInfo({
      projectRoot: FIXTURE_DIR,
      sdkPath: '/mock/sdk/default',
    });

    expect(result).toMatchObject({
      projectRoot: FIXTURE_DIR,
      projectType: 'application',
      modules: [
        {
          moduleName: 'entry',
          moduleType: 'entry',
          apiType: 'stageMode',
        },
      ],
    });
  });

  it('parses document symbols from provided text without DevEco', async () => {
    const service = createArktsMcpService();

    const result = await service.documentSymbols({
      text: '@Entry\n@Component\nstruct Index {\n  build() {}\n}',
    });

    expect(result).toMatchObject([
      {
        name: 'Index',
        kind: 23,
        detail: '@Entry @Component',
        children: [{ name: 'build', kind: 6 }],
      },
    ]);
  });

  it('parses workspace symbols from disk', async () => {
    const service = createArktsMcpService();

    const result = await service.workspaceSymbols({
      projectRoot: FIXTURE_DIR,
      query: 'CameraViewModel',
    });

    expect(result).toEqual([
      expect.objectContaining({
        name: 'CameraViewModel',
        kind: 5,
        location: expect.objectContaining({
          uri: expect.stringContaining('CameraPage.ets'),
        }),
      }),
    ]);
  });

  it('delegates hover requests to the ArkTS LSP client', async () => {
    const lspClient = {
      hover: vi.fn(async () => ({ contents: 'hover-ok' })),
      definition: vi.fn(),
      references: vi.fn(),
      signatureHelp: vi.fn(),
      diagnostics: vi.fn(),
      dispose: vi.fn(),
    };
    const service = createArktsMcpService({ lspClient });

    const result = await service.hover({
      projectRoot: FIXTURE_DIR,
      filePath: CAMERA_PAGE,
      position: { line: 1, character: 3 },
    });

    expect(lspClient.hover).toHaveBeenCalledWith({
      projectRoot: FIXTURE_DIR,
      filePath: CAMERA_PAGE,
      position: { line: 1, character: 3 },
    });
    expect(result).toEqual({ contents: 'hover-ok' });
  });
});
