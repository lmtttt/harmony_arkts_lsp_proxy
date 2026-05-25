import { createInterface } from 'node:readline';
import { createArktsMcpService } from './mcp-tools';

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ArktsMcpService {
  projectInfo: (args: unknown) => Promise<unknown>;
  documentSymbols: (args: unknown) => Promise<unknown>;
  workspaceSymbols: (args: unknown) => Promise<unknown>;
  hover: (args: unknown) => Promise<unknown>;
  definition: (args: unknown) => Promise<unknown>;
  references: (args: unknown) => Promise<unknown>;
  signatureHelp: (args: unknown) => Promise<unknown>;
  diagnostics: (args: unknown) => Promise<unknown>;
  dispose: () => void;
}

const POSITION_SCHEMA = {
  type: 'object',
  properties: {
    line: { type: 'number', description: 'Zero-based line number.' },
    character: { type: 'number', description: 'Zero-based UTF-16 character offset.' },
  },
  required: ['line', 'character'],
};

const LSP_FILE_PROPERTIES = {
  projectRoot: { type: 'string', description: 'HarmonyOS project root. If omitted, the server searches from filePath.' },
  filePath: { type: 'string', description: 'ArkTS/ETS file path.' },
  uri: { type: 'string', description: 'Optional file:// URI alternative to filePath.' },
  text: { type: 'string', description: 'Optional in-memory file text. If omitted, the file is read from disk.' },
  position: POSITION_SCHEMA,
  line: { type: 'number', description: 'Alternative to position.line.' },
  character: { type: 'number', description: 'Alternative to position.character.' },
};

export const ARKTS_MCP_TOOLS: McpTool[] = [
  {
    name: 'arkts_project_info',
    description: 'Parse a HarmonyOS ArkTS project and return ace-server initialization metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        projectRoot: { type: 'string', description: 'HarmonyOS project root containing build-profile.json5.' },
        startPath: { type: 'string', description: 'Path used to search upward/downward for build-profile.json5.' },
        sdkPath: { type: 'string', description: 'Optional DevEco SDK path override.' },
      },
    },
  },
  {
    name: 'arkts_document_symbols',
    description: 'Parse ArkTS/ArkUI document symbols from text or a file without starting DevEco.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'ArkTS/ETS source text.' },
        filePath: { type: 'string', description: 'Source file path.' },
        uri: { type: 'string', description: 'Source file URI.' },
      },
    },
  },
  {
    name: 'arkts_workspace_symbols',
    description: 'Search lightweight ArkTS/ETS workspace symbols under a HarmonyOS project root.',
    inputSchema: {
      type: 'object',
      properties: {
        projectRoot: { type: 'string', description: 'HarmonyOS project root.' },
        startPath: { type: 'string', description: 'Path used to discover the project root.' },
        query: { type: 'string', description: 'Symbol name substring to search for.' },
        maxFiles: { type: 'number', description: 'Optional scan file cap.' },
        maxResults: { type: 'number', description: 'Optional result cap.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'arkts_hover',
    description: 'Ask DevEco ace-server for ArkTS hover/type information at a file position.',
    inputSchema: {
      type: 'object',
      properties: LSP_FILE_PROPERTIES,
      required: ['filePath', 'position'],
    },
  },
  {
    name: 'arkts_definition',
    description: 'Ask DevEco ace-server for ArkTS definition locations at a file position.',
    inputSchema: {
      type: 'object',
      properties: LSP_FILE_PROPERTIES,
      required: ['filePath', 'position'],
    },
  },
  {
    name: 'arkts_references',
    description: 'Ask DevEco ace-server for ArkTS references at a file position.',
    inputSchema: {
      type: 'object',
      properties: LSP_FILE_PROPERTIES,
      required: ['filePath', 'position'],
    },
  },
  {
    name: 'arkts_signature_help',
    description: 'Ask DevEco ace-server for ArkTS signature help at a file position.',
    inputSchema: {
      type: 'object',
      properties: LSP_FILE_PROPERTIES,
      required: ['filePath', 'position'],
    },
  },
  {
    name: 'arkts_diagnostics',
    description: 'Open an ArkTS file through DevEco ace-server and return published diagnostics.',
    inputSchema: {
      type: 'object',
      properties: {
        projectRoot: LSP_FILE_PROPERTIES.projectRoot,
        filePath: LSP_FILE_PROPERTIES.filePath,
        uri: LSP_FILE_PROPERTIES.uri,
        text: LSP_FILE_PROPERTIES.text,
        timeoutMs: { type: 'number', description: 'How long to wait for diagnostics. Default: 1500ms.' },
      },
      required: ['filePath'],
    },
  },
];

function hasId(message: JsonRpcRequest): boolean {
  return Object.prototype.hasOwnProperty.call(message, 'id');
}

function result(id: JsonRpcId, value: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result: value };
}

function error(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function formatToolContent(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function getProtocolVersion(params: unknown): string {
  return isPlainObject(params) && typeof params.protocolVersion === 'string'
    ? params.protocolVersion
    : '2024-11-05';
}

export function createMcpHandler(service: ArktsMcpService = createArktsMcpService()) {
  return async function handleMcpRequest(message: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    if (!message.method) {
      return hasId(message) ? error(message.id ?? null, -32600, 'Invalid Request') : null;
    }

    if (!hasId(message)) {
      return null;
    }

    const id = message.id ?? null;

    try {
      if (message.method === 'initialize') {
        return result(id, {
          protocolVersion: getProtocolVersion(message.params),
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: 'arkts-lsp-proxy',
            version: '0.1.7',
          },
        });
      }

      if (message.method === 'tools/list') {
        return result(id, { tools: ARKTS_MCP_TOOLS });
      }

      if (message.method === 'tools/call') {
        const params = isPlainObject(message.params) ? message.params : {};
        const name = typeof params.name === 'string' ? params.name : '';
        const args = params.arguments ?? {};
        const handler = getToolHandler(service, name);
        if (!handler) {
          return error(id, -32601, `Unknown tool: ${name}`);
        }
        const value = await handler(args);
        return result(id, formatToolContent(value));
      }

      return error(id, -32601, `Method not found: ${message.method}`);
    } catch (err) {
      return result(id, {
        content: [
          {
            type: 'text',
            text: err instanceof Error ? err.message : String(err),
          },
        ],
        isError: true,
      });
    }
  };
}

function getToolHandler(service: ArktsMcpService, name: string): ((args: unknown) => Promise<unknown>) | null {
  switch (name) {
    case 'arkts_project_info':
      return service.projectInfo;
    case 'arkts_document_symbols':
      return service.documentSymbols;
    case 'arkts_workspace_symbols':
      return service.workspaceSymbols;
    case 'arkts_hover':
      return service.hover;
    case 'arkts_definition':
      return service.definition;
    case 'arkts_references':
      return service.references;
    case 'arkts_signature_help':
      return service.signatureHelp;
    case 'arkts_diagnostics':
      return service.diagnostics;
    default:
      return null;
  }
}

export function startMcpServer(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
  service: ArktsMcpService = createArktsMcpService(),
): () => void {
  const handler = createMcpHandler(service);
  const rl = createInterface({ input });

  rl.on('line', (line) => {
    void (async () => {
      let response: JsonRpcResponse | null;
      try {
        response = await handler(JSON.parse(line) as JsonRpcRequest);
      } catch (err) {
        response = error(null, -32700, 'Parse error', err instanceof Error ? err.message : String(err));
      }

      if (response) {
        output.write(`${JSON.stringify(response)}\n`);
      }
    })();
  });

  const dispose = () => {
    rl.close();
    service.dispose();
  };
  rl.on('close', () => service.dispose());
  return dispose;
}
