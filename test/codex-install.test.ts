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
  return root;
}

describe('Codex project installer', () => {
  it('creates project-scoped Codex MCP config in the requested project directory', () => {
    const projectRoot = makeProject();

    const result = installCodexProjectConfig(projectRoot);

    expect(result.changed).toBe(true);
    expect(result.installRoot).toBe(projectRoot);
    expect(result.backupPath).toBeUndefined();
    expect(fs.readFileSync(path.join(projectRoot, '.codex', 'config.toml'), 'utf8')).toBe(CODEX_MCP_CONFIG_BLOCK);
  });

  it('uses the containing directory when cwd points at a file', () => {
    const projectRoot = makeProject();
    const filePath = path.join(projectRoot, 'README.md');
    fs.writeFileSync(filePath, '# demo\n', 'utf8');

    const result = installCodexProjectConfig(filePath);

    expect(result.installRoot).toBe(projectRoot);
    expect(fs.readFileSync(path.join(projectRoot, '.codex', 'config.toml'), 'utf8')).toBe(CODEX_MCP_CONFIG_BLOCK);
  });

  it('does not scan for nested HarmonyOS projects during install', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'arkts-codex-workspace-'));
    const arktsProjectRoot = path.join(workspaceRoot, 'apps', 'phone');
    fs.mkdirSync(arktsProjectRoot, { recursive: true });
    fs.writeFileSync(path.join(arktsProjectRoot, 'build-profile.json5'), '{ app: {}, modules: [] }', 'utf8');

    const result = installCodexProjectConfig(workspaceRoot);

    expect(result.installRoot).toBe(workspaceRoot);
    expect(fs.readFileSync(path.join(workspaceRoot, '.codex', 'config.toml'), 'utf8')).toBe(CODEX_MCP_CONFIG_BLOCK);
    expect(fs.existsSync(path.join(arktsProjectRoot, '.codex', 'config.toml'))).toBe(false);
  });

  it('installs into an existing empty Codex project config', () => {
    const projectRoot = makeProject();
    const configDir = path.join(projectRoot, '.codex');
    const configPath = path.join(configDir, 'config.toml');
    fs.mkdirSync(configDir);
    fs.writeFileSync(configPath, '', 'utf8');

    const result = installCodexProjectConfig(projectRoot);

    expect(result.changed).toBe(true);
    expect(result.backupPath).toMatch(/config\.toml\.bak-\d{8}T\d{6}Z$/);
    expect(fs.readFileSync(result.backupPath as string, 'utf8')).toBe('');
    expect(fs.readFileSync(configPath, 'utf8')).toBe(CODEX_MCP_CONFIG_BLOCK);
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
    expect(second.backupPath).toBeUndefined();
  });

  it('backs up existing Codex project config before changing it', () => {
    const projectRoot = makeProject();
    const configDir = path.join(projectRoot, '.codex');
    const configPath = path.join(configDir, 'config.toml');
    const existing = `[mcp_servers.other]
command = "node"
`;
    fs.mkdirSync(configDir);
    fs.writeFileSync(configPath, existing, 'utf8');

    const result = installCodexProjectConfig(projectRoot);

    expect(result.changed).toBe(true);
    expect(result.backupPath).toMatch(/config\.toml\.bak-\d{8}T\d{6}Z$/);
    expect(fs.readFileSync(result.backupPath as string, 'utf8')).toBe(existing);
    expect(fs.readFileSync(configPath, 'utf8')).toContain('[mcp_servers.arkts-lsp]');
  });

  it('keeps only the newest three generated backups and leaves manual backups alone', () => {
    const projectRoot = makeProject();
    const configDir = path.join(projectRoot, '.codex');
    const configPath = path.join(configDir, 'config.toml');
    fs.mkdirSync(configDir);
    fs.writeFileSync(configPath, '[mcp_servers.other]\ncommand = "node"\n', 'utf8');
    for (let i = 0; i < 5; i += 1) {
      fs.writeFileSync(path.join(configDir, `config.toml.bak-20200101T00000${i}Z`), `old-${i}`, 'utf8');
    }
    fs.writeFileSync(path.join(configDir, 'config.toml.bak-manual'), 'manual', 'utf8');

    installCodexProjectConfig(projectRoot);

    const files = fs.readdirSync(configDir).sort();
    const generatedBackups = files.filter((name) => /^config\.toml\.bak-\d{8}T\d{6}Z(?:\.\d+)?$/.test(name));
    expect(generatedBackups).toHaveLength(3);
    expect(generatedBackups).not.toContain('config.toml.bak-20200101T000000Z');
    expect(generatedBackups).not.toContain('config.toml.bak-20200101T000001Z');
    expect(generatedBackups).not.toContain('config.toml.bak-20200101T000002Z');
    expect(files).toContain('config.toml.bak-manual');
  });

  it('does not write files during dry run', () => {
    const projectRoot = makeProject();

    const result = installCodexProjectConfig(projectRoot, true);

    expect(result.changed).toBe(true);
    expect(result.backupPath).toBeUndefined();
    expect(fs.existsSync(path.join(projectRoot, '.codex', 'config.toml'))).toBe(false);
  });

  it('installs even when the requested project directory is not a HarmonyOS project', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arkts-not-project-'));

    const result = installCodexProjectConfig(root);

    expect(result.installRoot).toBe(root);
    expect(fs.readFileSync(path.join(root, '.codex', 'config.toml'), 'utf8')).toBe(CODEX_MCP_CONFIG_BLOCK);
  });
});
