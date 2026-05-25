import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const PLUGIN_ROOT = path.join(REPO_ROOT, 'plugins', 'arkts-codex');

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

describe('Codex plugin packaging', () => {
  it('declares a Codex plugin with skills and MCP servers', () => {
    const manifest = readJson(path.join(PLUGIN_ROOT, '.codex-plugin', 'plugin.json'));

    expect(manifest).toMatchObject({
      name: 'arkts-codex',
      mcpServers: './.mcp.json',
      skills: './skills/',
      interface: {
        displayName: 'ArkTS LSP',
        category: 'Coding',
      },
    });
  });

  it('starts the ArkTS MCP server through npx package execution', () => {
    const mcp = readJson(path.join(PLUGIN_ROOT, '.mcp.json'));

    expect(mcp).toMatchObject({
      mcpServers: {
        'arkts-lsp': {
          command: 'npx',
          args: ['-y', '--package', 'arkts-lsp-proxy@latest', 'arkts-lsp-mcp'],
        },
      },
    });
  });

  it('includes a thin ArkTS skill that points Codex at the MCP tools', () => {
    const skill = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills', 'arkts', 'SKILL.md'), 'utf8');

    expect(skill).toContain('arkts_project_info');
    expect(skill).toContain('arkts_hover');
    expect(skill).toContain('arkts_diagnostics');
    expect(skill).toContain('Do not treat ArkTS as browser TypeScript');
  });
});
