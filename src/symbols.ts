import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface DocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}

export interface SymbolInformation {
  name: string;
  kind: number;
  location: {
    uri: string;
    range: Range;
  };
  containerName?: string;
}

const SYMBOL_KIND_CLASS = 5;
const SYMBOL_KIND_METHOD = 6;
const SYMBOL_KIND_PROPERTY = 7;
const SYMBOL_KIND_ENUM = 10;
const SYMBOL_KIND_INTERFACE = 11;
const SYMBOL_KIND_FUNCTION = 12;
const SYMBOL_KIND_VARIABLE = 13;
const SYMBOL_KIND_CONSTANT = 14;
const SYMBOL_KIND_STRUCT = 23;

const CONTAINER_KINDS = new Set([
  SYMBOL_KIND_CLASS,
  SYMBOL_KIND_STRUCT,
  SYMBOL_KIND_INTERFACE,
  SYMBOL_KIND_ENUM,
]);

const CONTROL_KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'function',
  'return',
]);

const WORKSPACE_EXCLUDES = new Set([
  '.git',
  '.hvigor',
  '.idea',
  '.vscode',
  'build',
  'dist',
  'node_modules',
  'oh_modules',
  'out',
]);

interface OpenSymbol {
  symbol: DocumentSymbol;
  openDepth: number;
}

function makeRange(line: number, start: number, end: number): Range {
  return {
    start: { line, character: Math.max(0, start) },
    end: { line, character: Math.max(Math.max(0, start), end) },
  };
}

function makeLineRange(line: number, lineText: string): Range {
  return makeRange(line, 0, lineText.length);
}

function maskStringsAndComments(line: string): string {
  let result = '';
  let quote: string | null = null;
  let escaped = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];

    if (!quote && ch === '/' && next === '/') {
      break;
    }

    if (quote) {
      result += ' ';
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      result += ' ';
      continue;
    }

    result += ch;
  }

  return result;
}

function countBraces(line: string): number {
  const masked = maskStringsAndComments(line);
  let delta = 0;
  for (const ch of masked) {
    if (ch === '{') {
      delta += 1;
    } else if (ch === '}') {
      delta -= 1;
    }
  }
  return delta;
}

function extractDecorators(line: string): string[] {
  return line.match(/@[A-Za-z_$][\w$]*(?:\([^)]*\))?/g) ?? [];
}

function removeLeadingDecorators(line: string): string {
  let rest = line.trim();
  while (rest.startsWith('@')) {
    const match = rest.match(/^@[A-Za-z_$][\w$]*(?:\([^)]*\))?\s*/);
    if (!match) {
      break;
    }
    rest = rest.slice(match[0].length).trim();
  }
  return rest;
}

function detailFromDecorators(decorators: string[]): string | undefined {
  return decorators.length > 0 ? decorators.join(' ') : undefined;
}

function symbolKindForContainer(keyword: string): number {
  switch (keyword) {
    case 'struct':
      return SYMBOL_KIND_STRUCT;
    case 'interface':
      return SYMBOL_KIND_INTERFACE;
    case 'enum':
      return SYMBOL_KIND_ENUM;
    default:
      return SYMBOL_KIND_CLASS;
  }
}

function findDirectContainer(stack: OpenSymbol[], braceDepth: number): OpenSymbol | null {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const entry = stack[i];
    if (CONTAINER_KINDS.has(entry.symbol.kind) && entry.openDepth === braceDepth) {
      return entry;
    }
  }
  return null;
}

function closeCompletedSymbols(stack: OpenSymbol[], braceDepth: number, line: number, lineText: string): void {
  while (stack.length > 0 && braceDepth < stack[stack.length - 1].openDepth) {
    const entry = stack.pop();
    if (!entry) {
      continue;
    }
    entry.symbol.range.end = {
      line: Math.max(entry.symbol.range.start.line, line),
      character: lineText.length,
    };
  }
}

function hasOpeningBraceAfterName(line: string, name: string): boolean {
  const index = line.indexOf(name);
  if (index < 0) {
    return false;
  }
  return maskStringsAndComments(line.slice(index + name.length)).includes('{');
}

function createSymbol(line: number, lineText: string, name: string, kind: number, detail?: string): DocumentSymbol {
  const start = Math.max(0, lineText.indexOf(name));
  return {
    name,
    detail,
    kind,
    range: makeLineRange(line, lineText),
    selectionRange: makeRange(line, start, start + name.length),
  };
}

export function parseDocumentSymbols(text: string): DocumentSymbol[] {
  const roots: DocumentSymbol[] = [];
  const stack: OpenSymbol[] = [];
  const lines = text.split(/\r?\n/);
  let braceDepth = 0;
  let pendingDecorators: string[] = [];

  lines.forEach((lineText, line) => {
    closeCompletedSymbols(stack, braceDepth, Math.max(0, line - 1), lines[Math.max(0, line - 1)] ?? '');

    const trimmed = lineText.trim();
    if (!trimmed) {
      return;
    }

    const decoratorsOnLine = extractDecorators(trimmed);
    if (decoratorsOnLine.length > 0 && removeLeadingDecorators(trimmed).length === 0) {
      pendingDecorators.push(...decoratorsOnLine);
      return;
    }

    const clean = removeLeadingDecorators(trimmed);
    const decorators = [...pendingDecorators, ...decoratorsOnLine];
    const detail = detailFromDecorators(decorators);
    const directContainer = findDirectContainer(stack, braceDepth);
    let matchedSymbol: DocumentSymbol | null = null;
    let opensBlock = false;

    const containerMatch = clean.match(/^(?:export\s+|declare\s+|default\s+|abstract\s+)*(struct|class|interface|enum)\s+([A-Za-z_$][\w$]*)/);
    if (containerMatch) {
      const [, keyword, name] = containerMatch;
      matchedSymbol = createSymbol(line, lineText, name, symbolKindForContainer(keyword), detail);
      opensBlock = hasOpeningBraceAfterName(lineText, name);
    } else {
      const functionMatch = clean.match(/^(?:export\s+|declare\s+|async\s+)*function\s+([A-Za-z_$][\w$]*)\s*(?:<[^>{}]*>)?\s*\(/);
      if (functionMatch && braceDepth === 0) {
        const [, name] = functionMatch;
        matchedSymbol = createSymbol(line, lineText, name, SYMBOL_KIND_FUNCTION, detail);
        opensBlock = hasOpeningBraceAfterName(lineText, name);
      }
    }

    if (!matchedSymbol && directContainer) {
      const methodMatch = clean.match(/^(?:(?:public|private|protected|static|async|override|abstract)\s+)*(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>{}]*>)?\s*\([^;{}]*\)\s*(?::[^=;{]+)?\s*(?:\{|$)/);
      if (methodMatch && !CONTROL_KEYWORDS.has(methodMatch[1])) {
        const [, name] = methodMatch;
        matchedSymbol = createSymbol(line, lineText, name, SYMBOL_KIND_METHOD, detail);
        opensBlock = hasOpeningBraceAfterName(lineText, name);
      } else {
        const propertyMatch = clean.match(/^(?:(?:public|private|protected|static|readonly)\s+)*(?:(?:let|const|var)\s+)?([A-Za-z_$][\w$]*)\s*(?::|=)/);
        if (propertyMatch) {
          const [, name] = propertyMatch;
          matchedSymbol = createSymbol(line, lineText, name, SYMBOL_KIND_PROPERTY, detail);
        }
      }
    }

    if (!matchedSymbol && braceDepth === 0) {
      const variableMatch = clean.match(/^(?:export\s+|declare\s+)*(const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::|=)/);
      if (variableMatch) {
        const [, declaration, name] = variableMatch;
        matchedSymbol = createSymbol(
          line,
          lineText,
          name,
          declaration === 'const' ? SYMBOL_KIND_CONSTANT : SYMBOL_KIND_VARIABLE,
          detail,
        );
      }
    }

    if (matchedSymbol) {
      const parent = directContainer && !CONTAINER_KINDS.has(matchedSymbol.kind) ? directContainer.symbol : null;
      if (parent) {
        parent.children = parent.children ?? [];
        parent.children.push(matchedSymbol);
      } else {
        roots.push(matchedSymbol);
      }

      if (opensBlock) {
        stack.push({
          symbol: matchedSymbol,
          openDepth: braceDepth + 1,
        });
      }
      pendingDecorators = [];
    } else if (decorators.length > 0 && !clean.startsWith('@')) {
      pendingDecorators = [];
    }

    braceDepth = Math.max(0, braceDepth + countBraces(lineText));
  });

  closeCompletedSymbols(stack, -1, Math.max(0, lines.length - 1), lines[lines.length - 1] ?? '');
  return roots;
}

function isArkTsSourceFile(filePath: string): boolean {
  return (
    filePath.endsWith('.ets') ||
    filePath.endsWith('.d.ets') ||
    filePath.endsWith('.ts') ||
    filePath.endsWith('.d.ts')
  );
}

function collectSourceFiles(root: string, files: string[], maxFiles: number): void {
  if (files.length >= maxFiles) {
    return;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (files.length >= maxFiles) {
      return;
    }

    if (WORKSPACE_EXCLUDES.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(fullPath, files, maxFiles);
    } else if (entry.isFile() && isArkTsSourceFile(fullPath)) {
      files.push(fullPath);
    }
  }
}

function flattenSymbols(
  uri: string,
  symbols: DocumentSymbol[],
  query: string,
  results: SymbolInformation[],
  maxResults: number,
  containerName?: string,
): void {
  const normalizedQuery = query.trim().toLowerCase();

  for (const symbol of symbols) {
    if (results.length >= maxResults) {
      return;
    }

    if (!normalizedQuery || symbol.name.toLowerCase().includes(normalizedQuery)) {
      results.push({
        name: symbol.name,
        kind: symbol.kind,
        location: {
          uri,
          range: symbol.selectionRange,
        },
        ...(containerName ? { containerName } : {}),
      });
    }

    if (symbol.children) {
      flattenSymbols(uri, symbol.children, query, results, maxResults, symbol.name);
    }
  }
}

export function parseWorkspaceSymbols(
  projectRoot: string,
  query: string,
  options?: { maxFiles?: number; maxResults?: number },
): SymbolInformation[] {
  const maxFiles = options?.maxFiles ?? 1000;
  const maxResults = options?.maxResults ?? 200;
  const normalizedQuery = query.trim();
  const files: string[] = [];
  const results: SymbolInformation[] = [];

  if (!normalizedQuery) {
    return [];
  }

  collectSourceFiles(projectRoot, files, maxFiles);

  for (const filePath of files) {
    if (results.length >= maxResults) {
      break;
    }

    let text: string;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    flattenSymbols(pathToFileURL(filePath).toString(), parseDocumentSymbols(text), normalizedQuery, results, maxResults);
  }

  return results;
}
