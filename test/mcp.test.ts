import { describe, expect, it, vi } from 'vitest';
import { ARKTS_MCP_TOOLS, createMcpHandler, type ArktsMcpService } from '../src/mcp';

function createService(overrides: Partial<ArktsMcpService> = {}): ArktsMcpService {
  return {
    projectInfo: vi.fn(async () => ({ projectRoot: '/project', modules: [] })),
    documentSymbols: vi.fn(async () => [{ name: 'Index', kind: 23 }]),
    workspaceSymbols: vi.fn(async () => [{ name: 'CameraViewModel', kind: 5 }]),
    hover: vi.fn(async () => ({ contents: 'hover-ok' })),
    definition: vi.fn(async () => [{ uri: 'file:///project/Index.ets' }]),
    references: vi.fn(async () => []),
    signatureHelp: vi.fn(async () => null),
    diagnostics: vi.fn(async () => []),
    dispose: vi.fn(),
    ...overrides,
  };
}

describe('MCP protocol handler', () => {
  it('responds to initialize with tool capabilities', async () => {
    const handler = createMcpHandler(createService());

    const response = await handler({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '0.0.0' },
      },
    });

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: 'arkts-lsp-proxy',
        },
      },
    });
  });

  it('lists ArkTS MCP tools', async () => {
    const handler = createMcpHandler(createService());

    const response = await handler({
      jsonrpc: '2.0',
      id: 'tools',
      method: 'tools/list',
    });

    const names = (response?.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
    expect(names).toContain('arkts_project_info');
    expect(names).toContain('arkts_document_symbols');
    expect(names).toContain('arkts_workspace_symbols');
    expect(names).toContain('arkts_hover');
    expect(names).toContain('arkts_definition');
    expect(names).toContain('arkts_diagnostics');
    expect(ARKTS_MCP_TOOLS.every((tool) => names.includes(tool.name))).toBe(true);
  });

  it('calls a tool and returns JSON as MCP text content', async () => {
    const service = createService();
    const handler = createMcpHandler(service);

    const response = await handler({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'arkts_document_symbols',
        arguments: {
          text: '@Component\nstruct Index {}',
        },
      },
    });

    expect(service.documentSymbols).toHaveBeenCalledWith({ text: '@Component\nstruct Index {}' });
    expect(response?.result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify([{ name: 'Index', kind: 23 }], null, 2),
        },
      ],
    });
  });

  it('returns JSON-RPC errors for unknown tools', async () => {
    const handler = createMcpHandler(createService());

    const response = await handler({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'missing_tool',
        arguments: {},
      },
    });

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 3,
      error: {
        code: -32601,
      },
    });
  });

  it('does not respond to notifications', async () => {
    const handler = createMcpHandler(createService());

    await expect(
      handler({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    ).resolves.toBeNull();
  });
});
