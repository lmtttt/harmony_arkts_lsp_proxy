import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArktsLanguageClient, type ArktsDiagnosticsRequest, type ArktsRequest } from './arkts-client';
import { findDevEcoEnv } from './env';
import { findProjectRoot, parseProject } from './project';
import { parseDocumentSymbols, parseWorkspaceSymbols } from './symbols';
import type { ArktsMcpService } from './mcp';

interface ArktsLspClientLike {
  hover: (request: ArktsRequest) => Promise<unknown>;
  definition: (request: ArktsRequest) => Promise<unknown>;
  references: (request: ArktsRequest) => Promise<unknown>;
  signatureHelp: (request: ArktsRequest) => Promise<unknown>;
  diagnostics: (request: ArktsDiagnosticsRequest) => Promise<unknown[]>;
  dispose: () => void;
}

interface ServiceOptions {
  lspClient?: ArktsLspClientLike;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getString(args: Record<string, unknown>, key: string): string | undefined {
  return typeof args[key] === 'string' && args[key].length > 0 ? args[key] : undefined;
}

function getNumber(args: Record<string, unknown>, key: string): number | undefined {
  return typeof args[key] === 'number' && Number.isFinite(args[key]) ? args[key] : undefined;
}

function uriToFilePath(uri: string): string {
  return uri.startsWith('file://') ? fileURLToPath(uri) : uri;
}

function resolveRoot(rawRoot: string | undefined, rawStart: string | undefined): string {
  const candidate = rawRoot ?? rawStart ?? process.cwd();
  const normalized = candidate.startsWith('file://') ? uriToFilePath(candidate) : candidate;
  const resolved = findProjectRoot(path.resolve(normalized));
  if (!resolved) {
    throw new Error(`No ArkTS project root found for ${normalized}`);
  }
  return resolved;
}

function readText(args: Record<string, unknown>): string {
  const text = getString(args, 'text');
  if (text !== undefined) {
    return text;
  }

  const rawFile = getString(args, 'filePath') ?? getString(args, 'uri');
  if (!rawFile) {
    throw new Error('Expected either text, filePath, or uri.');
  }

  return fs.readFileSync(uriToFilePath(rawFile), 'utf8');
}

function normalizePosition(args: Record<string, unknown>): { line: number; character: number } {
  const position = args.position;
  if (isPlainObject(position)) {
    const line = getNumber(position, 'line');
    const character = getNumber(position, 'character');
    if (line !== undefined && character !== undefined) {
      return { line, character };
    }
  }

  const line = getNumber(args, 'line');
  const character = getNumber(args, 'character');
  if (line === undefined || character === undefined) {
    throw new Error('Expected position with line and character.');
  }
  return { line, character };
}

function normalizeLspRequest(args: Record<string, unknown>): ArktsRequest {
  const rawFile = getString(args, 'filePath') ?? getString(args, 'uri');
  if (!rawFile) {
    throw new Error('Expected filePath or uri.');
  }
  return {
    projectRoot: getString(args, 'projectRoot'),
    filePath: uriToFilePath(rawFile),
    position: normalizePosition(args),
    text: getString(args, 'text'),
  };
}

export function createArktsMcpService(options: ServiceOptions = {}): ArktsMcpService {
  const lspClient = options.lspClient ?? new ArktsLanguageClient();

  return {
    async projectInfo(rawArgs) {
      const args = isPlainObject(rawArgs) ? rawArgs : {};
      const projectRoot = resolveRoot(getString(args, 'projectRoot'), getString(args, 'startPath'));
      const sdkPath = getString(args, 'sdkPath') ?? findDevEcoEnv()?.sdkPath;
      if (!sdkPath) {
        throw new Error('DevEco Studio not found. Pass sdkPath or set DEVECO_HOME.');
      }

      const project = parseProject(projectRoot, sdkPath);
      if (!project) {
        throw new Error(`Unable to parse ArkTS project at ${projectRoot}`);
      }
      return project;
    },

    async documentSymbols(rawArgs) {
      const args = isPlainObject(rawArgs) ? rawArgs : {};
      return parseDocumentSymbols(readText(args));
    },

    async workspaceSymbols(rawArgs) {
      const args = isPlainObject(rawArgs) ? rawArgs : {};
      const query = getString(args, 'query') ?? '';
      const projectRoot = resolveRoot(getString(args, 'projectRoot'), getString(args, 'startPath'));
      return parseWorkspaceSymbols(projectRoot, query, {
        maxFiles: getNumber(args, 'maxFiles'),
        maxResults: getNumber(args, 'maxResults'),
      });
    },

    async hover(rawArgs) {
      return lspClient.hover(normalizeLspRequest(isPlainObject(rawArgs) ? rawArgs : {}));
    },

    async definition(rawArgs) {
      return lspClient.definition(normalizeLspRequest(isPlainObject(rawArgs) ? rawArgs : {}));
    },

    async references(rawArgs) {
      return lspClient.references(normalizeLspRequest(isPlainObject(rawArgs) ? rawArgs : {}));
    },

    async signatureHelp(rawArgs) {
      return lspClient.signatureHelp(normalizeLspRequest(isPlainObject(rawArgs) ? rawArgs : {}));
    },

    async diagnostics(rawArgs) {
      const args = isPlainObject(rawArgs) ? rawArgs : {};
      const request = normalizeLspRequest(args);
      return lspClient.diagnostics({
        projectRoot: request.projectRoot,
        filePath: request.filePath,
        text: request.text,
        timeoutMs: getNumber(args, 'timeoutMs'),
      });
    },

    dispose() {
      lspClient.dispose();
    },
  };
}
