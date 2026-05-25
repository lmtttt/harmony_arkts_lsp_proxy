import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CODEX_MCP_CONFIG_BLOCK,
  installCodexProjectConfig,
  upsertCodexMcpConfig,
} from '../src/codex-install';

function makeProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arkts-codex-install-'));
  fs.writeFileSync(path.join(root, 'build-profile.json5'), '{ app: {}, modules: [] }', 'utf8');
  return root;
}

describe('Codex project installer', () => {
  it('creates project-scoped Codex MCP config in a HarmonyOS project', () => {
    const projectRoot = makeProject();

    const result = installCodexProjectConfig(projectRoot);

    expect(result.changed).toBe(true);
    expect(result.projectRoot).toBe(projectRoot);
    expect(fs.readFileSync(path.join(projectRoot, '.codex', 'config.toml'), 'utf8')).toBe(CODEX_MCP_CONFIG_BLOCK);
  });

  it('updates only the ArkTS MCP block while preserving other project config', () => {
    const existing = `[projects."/tmp/demo"]
trust_level = "trusted"

[mcp_servers.other]
command = "node"
args = ["server.js"]

[mcp_servers.arkts-lsp]
command = "old"

[mcp_servers.arkts-lsp.env]
ARKTS_LSP_SYNC = "never"

[notice]
fast_default_opt_out = true
`;

    const updated = upsertCodexMcpConfig(existing);

    expect(updated).toContain('[mcp_servers.other]');
    expect(updated).toContain('[notice]');
    expect(updated).not.toContain('command = "old"');
    expect(updated).toContain('command = "npx"');
    expect(updated).toContain('ARKTS_LSP_SYNC = "auto"');
  });

  it('is idempotent after the first install', () => {
    const projectRoot = makeProject();

    installCodexProjectConfig(projectRoot);
    const second = installCodexProjectConfig(projectRoot);

    expect(second.changed).toBe(false);
  });

  it('fails outside a HarmonyOS project', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arkts-not-project-'));

    expect(() => installCodexProjectConfig(root)).toThrow(/HarmonyOS project root not found/);
  });
});
