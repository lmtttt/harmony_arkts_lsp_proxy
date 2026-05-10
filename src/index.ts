#!/usr/bin/env node

import { findDevEcoEnv } from './env';
import { createProxy } from './proxy';

function parseProjectRootHint(): string | undefined {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    if ((args[i] === '--project-root' || args[i] === '--root' || args[i] === '--cwd') && i + 1 < args.length) {
      return args[i + 1];
    }
    if (args[i].startsWith('--project-root=')) {
      return args[i].slice('--project-root='.length);
    }
  }
  return undefined;
}

function main(): void {
  process.stderr.write('[arkts-lsp] Starting ArkTS LSP Proxy\n');

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

  const projectRootHint = parseProjectRootHint();
  const proxy = createProxy(process.stdin, process.stdout, env, { env, projectRootHint });

  const cleanup = () => {
    proxy.dispose();
  };

  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });
  process.stdin.on('end', cleanup);
}

main();
