import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'stream';
import { injectInitializationOptions, createProxy, type ProxyHandle, type InitializationPayload } from '../src/proxy';
import type { ChildProcess } from 'child_process';

describe('injectInitializationOptions', () => {
  const payload: InitializationPayload = {
    rootUri: 'file:///my/project',
    lspServerWorkspacePath: '/my/project',
    modules: [{
      moduleName: 'entry',
      modulePath: '/my/project/entry',
      deviceType: ['phone'],
      aceLoaderPath: '/sdk/js/framework/phone/ace-loader',
      jsComponentType: 0,
      sdkJsPath: '/sdk/js/api/phone/',
      compatibleSdkLevel: '12',
      apiType: 'Stage',
    }],
  };

  it('injects initializationOptions into a request without them', () => {
    const original = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        processId: 1234,
        capabilities: {},
      },
    };

    const result = injectInitializationOptions(original, payload);
    expect(result.params.initializationOptions).toBeDefined();
    expect(result.params.initializationOptions.rootUri).toBe('file:///my/project');
    expect(result.params.initializationOptions.modules).toHaveLength(1);
    expect(result.params.initializationOptions.modules[0].moduleName).toBe('entry');
    expect(result.params.processId).toBe(1234);
  });

  it('merges with existing initializationOptions', () => {
    const original = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        processId: 1234,
        capabilities: {},
        initializationOptions: {
          clientType: 'claude-code',
        },
      },
    };

    const result = injectInitializationOptions(original, payload);
    expect(result.params.initializationOptions.clientType).toBe('claude-code');
    expect(result.params.initializationOptions.rootUri).toBe('file:///my/project');
  });

  it('does not modify non-initialize requests', () => {
    const original = {
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: { textDocument: { uri: 'file:///test.ets' } },
    };

    const result = injectInitializationOptions(original, payload);
    expect(result.params.initializationOptions).toBeUndefined();
  });
});

describe('proxy integration', () => {
  it('transforms initialize message end-to-end through streams', () => {
    const payload: InitializationPayload = {
      rootUri: 'file:///test/project',
      lspServerWorkspacePath: '/test/project',
      modules: [{
        moduleName: 'entry',
        modulePath: '/test/project/entry',
        deviceType: ['phone'],
        aceLoaderPath: '/sdk/js/framework/phone/ace-loader',
        jsComponentType: 0,
        sdkJsPath: '/sdk/js/api/phone/',
        compatibleSdkLevel: '12',
        apiType: 'Stage',
      }],
    };

    // Simulate a real LSP initialize message
    const lspMessage = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        processId: 5678,
        rootUri: null,
        capabilities: {
          textDocument: {
            hover: { contentFormat: ['markdown'] },
          },
        },
      },
    };

    const result = injectInitializationOptions(lspMessage, payload);

    // Verify the injected fields
    expect(result.params.initializationOptions.rootUri).toBe('file:///test/project');
    expect(result.params.initializationOptions.lspServerWorkspacePath).toBe('/test/project');
    expect(result.params.initializationOptions.modules[0].apiType).toBe('Stage');

    // Verify original fields are preserved
    expect(result.params.processId).toBe(5678);
    expect(result.params.capabilities.textDocument.hover.contentFormat).toEqual(['markdown']);
    expect(result.id).toBe(1);
    expect(result.method).toBe('initialize');
  });
});

describe('createProxy', () => {
  function makeMockAceProcess(): { proc: ChildProcess; aceIn: PassThrough; aceOut: PassThrough } {
    const aceIn = new PassThrough(); // ace stdout → client reads
    const aceOut = new PassThrough(); // client writes → ace stdin
    const proc = {
      stdout: aceIn,
      stdin: aceOut,
      on: vi.fn(),
      kill: vi.fn(),
    } as unknown as ChildProcess;
    return { proc, aceIn, aceOut };
  }

  it('returns a ProxyHandle with dispose()', () => {
    const clientIn = new PassThrough();
    const clientOut = new PassThrough();
    const { proc } = makeMockAceProcess();

    const handle = createProxy(clientIn, clientOut, proc, {
      rootUri: 'file:///test',
      lspServerWorkspacePath: '/test',
      modules: [],
    });

    expect(handle).toBeDefined();
    expect(handle.dispose).toBeInstanceOf(Function);
    handle.dispose();
  });

  it('dispose() closes both connections without throwing', () => {
    const clientIn = new PassThrough();
    const clientOut = new PassThrough();
    const { proc } = makeMockAceProcess();

    const handle = createProxy(clientIn, clientOut, proc, {
      rootUri: 'file:///test',
      lspServerWorkspacePath: '/test',
      modules: [],
    });

    expect(() => handle.dispose()).not.toThrow();
  });

  it('throws when aceProcess has no stdout', () => {
    const clientIn = new PassThrough();
    const clientOut = new PassThrough();
    const proc = {
      stdout: null,
      stdin: new PassThrough(),
      on: vi.fn(),
    } as unknown as ChildProcess;

    expect(() =>
      createProxy(clientIn, clientOut, proc, {
        rootUri: 'file:///test',
        lspServerWorkspacePath: '/test',
        modules: [],
      })
    ).toThrow('aceProcess must have both stdout and stdin streams');
  });

  it('throws when aceProcess has no stdin', () => {
    const clientIn = new PassThrough();
    const clientOut = new PassThrough();
    const proc = {
      stdout: new PassThrough(),
      stdin: null,
      on: vi.fn(),
    } as unknown as ChildProcess;

    expect(() =>
      createProxy(clientIn, clientOut, proc, {
        rootUri: 'file:///test',
        lspServerWorkspacePath: '/test',
        modules: [],
      })
    ).toThrow('aceProcess must have both stdout and stdin streams');
  });
});
