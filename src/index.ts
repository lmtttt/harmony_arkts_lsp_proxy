#!/usr/bin/env node

import { findDevEcoEnv } from './env';
import { parseProject } from './project';
import { runHvigorSync } from './hvigor';
import { startAceServer } from './ace-server';
import { createProxy } from './proxy';

function main(): void {
  process.stderr.write('[arkts-lsp] Starting ArkTS LSP Proxy\n');

  // Step 1: Find DevEco Studio
  const env = findDevEcoEnv();
  if (!env) {
    process.stderr.write('==============================================\n');
    process.stderr.write('  ArkTS LSP: DevEco Studio not found!\n\n');
    process.stderr.write('  Set the environment variable:\n');
    process.stderr.write('    export DEVECO_HOME=/Applications/DevEco-Studio.app\n');
    process.stderr.write('==============================================\n');
    process.exit(1);
  }
  process.stderr.write(`[arkts-lsp] DevEco: ${env.devecoHome}\n`);

  // Step 2: Find project root
  const cwd = process.cwd();
  const project = parseProject(cwd, env.sdkPath);
  if (!project) {
    process.stderr.write(`[arkts-lsp] No HarmonyOS project found at ${cwd}\n`);
    process.stderr.write('[arkts-lsp] Expected build-profile.json5 in current or parent directory\n');
    process.exit(1);
  }
  process.stderr.write(`[arkts-lsp] Project: ${project.projectRoot}\n`);
  process.stderr.write(`[arkts-lsp] Modules: ${project.modules.map(m => m.moduleName).join(', ')}\n`);

  // Step 3: Run hvigor sync
  const syncOk = runHvigorSync(env, project.projectRoot);
  if (!syncOk) {
    process.stderr.write('[arkts-lsp] hvigor sync failed, continuing anyway\n');
  }

  // Step 4: Start ace-server
  const ace = startAceServer(env);

  // Step 5: Set up LSP proxy
  createProxy(process.stdin, process.stdout, ace.process, {
    rootUri: project.rootUri,
    lspServerWorkspacePath: project.lspServerWorkspacePath,
    modules: project.modules,
  });

  // Step 6: Handle cleanup
  process.on('SIGINT', () => ace.kill());
  process.on('SIGTERM', () => ace.kill());
  process.stdin.on('end', () => ace.kill());
}

main();
