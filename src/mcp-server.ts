#!/usr/bin/env node

import { startMcpServer } from './mcp';

const dispose = startMcpServer();

process.on('SIGINT', () => {
  dispose();
  process.exit(0);
});

process.on('SIGTERM', () => {
  dispose();
  process.exit(0);
});
