import { describe, it, expect } from 'vitest';
import { injectInitializationOptions, type InitializationPayload } from '../src/proxy';

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
