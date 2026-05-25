#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import { findProjectRoot } from './project';

const SERVER_NAME = 'arkts-lsp';
const CONFIG_RELATIVE_PATH = path.join('.codex', 'config.toml');

export const CODEX_MCP_CONFIG_BLOCK = `[mcp_servers.${SERVER_NAME}]
command = "npx"
args = ["-y", "--package", "arkts-lsp-proxy@latest", "arkts-lsp-mcp"]

[mcp_servers.${SERVER_NAME}.env]
ARKTS_LSP_SYNC = "auto"
`;

interface CliOptions {
  startDir: string;
  dryRun: boolean;
  help: boolean;
}

interface InstallResult {
  projectRoot: string;
  configPath: string;
  backupPath?: string;
  changed: boolean;
  content: string;
}

function usage(): string {
  return `Usage: arkts-lsp-codex-install [--cwd <path>] [--dry-run]

Install ArkTS LSP MCP into the current HarmonyOS project's .codex/config.toml.

Options:
  --cwd <path>  Start project detection from this directory or file.
  --dry-run     Print the config path and content without writing files.
  -h, --help    Show this help.
`;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    startDir: process.cwd(),
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if ((arg === '--cwd' || arg === '--project-root') && argv[i + 1]) {
      options.startDir = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--cwd=')) {
      options.startDir = arg.slice('--cwd='.length);
      continue;
    }
    if (arg.startsWith('--project-root=')) {
      options.startDir = arg.slice('--project-root='.length);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function isArktsServerTable(tableName: string): boolean {
  return tableName === `mcp_servers.${SERVER_NAME}` || tableName.startsWith(`mcp_servers.${SERVER_NAME}.`);
}

function stripExistingArktsServerBlock(existing: string): string {
  const lines = existing.split(/\r?\n/);
  const kept: string[] = [];
  let skipping = false;

  for (const line of lines) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      skipping = isArktsServerTable(header[1]);
    }
    if (!skipping) {
      kept.push(line);
    }
  }

  return kept.join('\n').trimEnd();
}

export function upsertCodexMcpConfig(existing: string): string {
  const withoutOldBlock = stripExistingArktsServerBlock(existing);
  return `${withoutOldBlock ? `${withoutOldBlock}\n\n` : ''}${CODEX_MCP_CONFIG_BLOCK}`;
}

function formatTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function nextBackupPath(configPath: string): string {
  const basePath = `${configPath}.bak-${formatTimestamp()}`;
  let candidate = basePath;
  let suffix = 1;
  while (fs.existsSync(candidate)) {
    candidate = `${basePath}.${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function writeFileAtomically(filePath: string, content: string): void {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, content, 'utf8');
  fs.renameSync(tempPath, filePath);
}

export function installCodexProjectConfig(startDir: string, dryRun = false): InstallResult {
  const projectRoot = findProjectRoot(startDir);
  if (!projectRoot) {
    throw new Error(
      `HarmonyOS project root not found from ${path.resolve(startDir)}. Run this command inside a project with build-profile.json5.`,
    );
  }

  const codexDir = path.join(projectRoot, '.codex');
  const configPath = path.join(projectRoot, CONFIG_RELATIVE_PATH);
  const hadExistingConfig = fs.existsSync(configPath);
  const existing = hadExistingConfig ? fs.readFileSync(configPath, 'utf8') : '';
  const content = upsertCodexMcpConfig(existing);
  const changed = existing !== content;
  let backupPath: string | undefined;

  if (!dryRun && changed) {
    fs.mkdirSync(codexDir, { recursive: true });
    if (hadExistingConfig) {
      backupPath = nextBackupPath(configPath);
      fs.copyFileSync(configPath, backupPath);
    }
    writeFileAtomically(configPath, content);
  }

  return {
    projectRoot,
    configPath,
    backupPath,
    changed,
    content,
  };
}

function main(): void {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage());
      return;
    }

    const result = installCodexProjectConfig(options.startDir, options.dryRun);
    process.stdout.write(`[arkts-lsp] project: ${result.projectRoot}\n`);
    process.stdout.write(`[arkts-lsp] codex config: ${result.configPath}\n`);
    if (result.backupPath) {
      process.stdout.write(`[arkts-lsp] backup: ${result.backupPath}\n`);
    }
    if (options.dryRun) {
      process.stdout.write('\n');
      process.stdout.write(result.content);
      return;
    }
    process.stdout.write(
      result.changed
        ? '[arkts-lsp] installed project-scoped Codex MCP config\n'
        : '[arkts-lsp] project-scoped Codex MCP config already up to date\n',
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[arkts-lsp] ${message}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
