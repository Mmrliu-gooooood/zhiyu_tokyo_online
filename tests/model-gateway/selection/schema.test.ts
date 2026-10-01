import { describe, expect, it } from 'vitest';
import { ModelSelectionError } from '@/lib/model-gateway/selection/errors';
import { readModelSelection } from '@/lib/model-gateway/selection/read-request';
import {
  modelSelectionSchema,
  upgradeLegacyModelParams,
} from '@/lib/model-gateway/selection/schema';

function request(headers: Record<string, string>) {
  return { headers: new Headers(headers) };
}

function errorOf(fn: () => unknown): ModelSelectionError | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof ModelSelectionError) return error;
    throw error;
  }
  return undefined;
}

describe('readModelSelection (request headers)', () => {
  it('reads a user selection with its connection and body thinking', () => {
    const result = readModelSelection(
      request({
        'x-model': 'deepseek:deepseek-flash',
        'x-api-key': 'sk-user',
        'x-base-url': 'https://relay.example/v1',
        'x-model-source': 'user',
        'x-platform-default-id': '',
      }),
      { thinkingConfig: { mode: 'enabled', effort: 'high' } },
    );
    expect(result).toEqual({
      selection: {
        source: 'user',
        providerId: 'deepseek',
        modelId: 'deepseek-flash',
        connection: { auth: 'api-key', apiKey: 'sk-user', baseUrl: 'https://relay.example/v1' },
        thinking: { mode: 'enabled', effort: 'high' },
      },
    });
  });

  it('reads a platform selection and ignores client model/key fields', () => {
    const result = readModelSelection(
      request({
        'x-model': 'openai:attacker',
        'x-api-key': 'sk-user',
        'x-model-source': 'platform',
        'x-platform-default-id': 'zhiyu-default-text',
      }),
    );
    expect(result.selection).toEqual({ source: 'platform', defaultId: 'zhiyu-default-text' });
  });

  it('returns no selection without x-model (DEFAULT_MODEL applies)', () => {
    expect(readModelSelection(request({})).selection).toBeUndefined();
  });

  it('maps a custom provider type to its wire API and keeps the legacy-managed source', () => {
    const result = readModelSelection(
      request({
        'x-model': 'custom-gateway:my-model',
        'x-api-key': 'sk-custom',
        'x-base-url': 'https://custom.example/v1',
        'x-provider-type': 'anthropic',
      }),
    );
    expect(result.selection).toEqual({
      source: 'legacy-managed',
      providerId: 'custom-gateway',
      modelId: 'my-model',
      connection: {
        auth: 'api-key',
        apiKey: 'sk-custom',
        baseUrl: 'https://custom.example/v1',
        api: 'anthropic-messages',
      },
    });
  });

  it('uses a keyless connection for local providers', () => {
    const result = readModelSelection(
      request({ 'x-model': 'ollama:llama3.3', 'x-model-source': 'user' }),
    );
    expect(result.selection).toMatchObject({ connection: { auth: 'none' } });
  });

  it('reads the new endpoint headers', () => {
    const result = readModelSelection(
      request({
        'x-model': 'cloudflare-workers-ai:@cf/openai/gpt-oss-120b',
        'x-api-key': 'cf-key',
        'x-model-source': 'user',
        'x-model-endpoint-params': JSON.stringify({ CLOUDFLARE_ACCOUNT_ID: 'acct-1' }),
        'x-model-api': 'openai-completions',
      }),
    );
    expect(result.selection).toMatchObject({
      providerId: 'cloudflare-workers-ai',
      modelId: '@cf/openai/gpt-oss-120b',
      connection: {
        auth: 'api-key',
        api: 'openai-completions',
        endpointParams: { CLOUDFLARE_ACCOUNT_ID: 'acct-1' },
      },
    });
  });

  it.each([
    [
      { 'x-model-source': 'invalid-source' },
      'INVALID_MODEL_SOURCE',
      'Invalid model source: invalid-source',
    ],
    [
      { 'x-model': 'openai:gpt-5.4', 'x-platform-default-id': 'zhiyu-default-text' },
      'INVALID_MODEL_SOURCE',
      'A platform default ID can only be used with the platform model source.',
    ],
    [
      { 'x-model-source': 'platform' },
      'INVALID_MODEL_SOURCE',
      'A platform model selection requires a platform default ID.',
    ],
    [
      { 'x-model': 'platform:zhiyu-default-text', 'x-model-source': 'user' },
      'INVALID_MODEL_SOURCE',
      'A user model selection cannot reference a platform default.',
    ],
    [
      { 'x-model': 'ollama:llama3.3', 'x-provider-type': 'bedrock' },
      'INVALID_MODEL_SELECTION',
      'Provider type mismatch for ollama: expected openai, received bedrock.',
    ],
  ])('defers legacy rejections as errors: %o', (headers, code, message) => {
    const result = readModelSelection(request(headers as Record<string, string>));
    expect(result.selection).toBeUndefined();
    expect(result.error).toMatchObject({ code, httpStatus: 400, message });
  });

  it('rejects a key and a credential together', () => {
    const result = readModelSelection(
      request({
        'x-model': 'openrouter:openai/gpt-5.5',
        'x-model-source': 'user',
        'x-api-key': 'sk-user',
        'x-model-credential-id': '00000000-0000-4000-8000-000000000000',
      }),
    );
    expect(result.error?.code).toBe('INVALID_MODEL_SOURCE');
  });

  it('rejects an invalid body thinking config', () => {
    const result = readModelSelection(request({ 'x-model': 'deepseek:deepseek-flash' }), {
      thinkingConfig: { effort: 'ultra' },
    });
    expect(result.error?.code).toBe('INVALID_MODEL_SELECTION');
  });
});

describe('upgradeLegacyModelParams (persisted shapes)', () => {
  it('upgrades a PRO v1 user connection', () => {
    expect(
      upgradeLegacyModelParams({
        source: 'user',
        modelString: 'openai:gpt-5.4',
        apiKey: 'sk-user',
        api: 'openai-responses',
        thinkingConfig: { effort: 'low' },
      }),
    ).toEqual({
      source: 'user',
      providerId: 'openai',
      modelId: 'gpt-5.4',
      connection: { auth: 'api-key', apiKey: 'sk-user', api: 'openai-responses' },
      thinking: { effort: 'low' },
    });
  });

  it('upgrades a PRO v1 / snapshot v2 platform reference', () => {
    expect(
      upgradeLegacyModelParams({
        source: 'platform',
        defaultId: 'zhiyu-default-text',
        revision: 'rev-1',
      }),
    ).toEqual({ source: 'platform', defaultId: 'zhiyu-default-text', revision: 'rev-1' });
  });

  it('upgrades a snapshot v1 (no source) as legacy-managed with its connection', () => {
    expect(
      upgradeLegacyModelParams({
        modelString: 'qwen:qwen3.7-plus',
        apiKey: 'sk-old',
        providerType: 'openai',
      }),
    ).toEqual({
      source: 'legacy-managed',
      providerId: 'qwen',
      modelId: 'qwen3.7-plus',
      connection: { auth: 'api-key', apiKey: 'sk-old' },
    });
  });

  it('upgrades a bare model id to the deprecated OpenAI default', () => {
    expect(upgradeLegacyModelParams({ modelString: 'gpt-5.4-mini' })).toEqual({
      source: 'legacy-managed',
      providerId: 'openai',
      modelId: 'gpt-5.4-mini',
    });
  });

  it('ignores an unknown dialect, as the legacy adapter did', () => {
    expect(
      upgradeLegacyModelParams({
        source: 'user',
        modelString: 'openai:gpt-5.4',
        apiKey: 'k',
        api: 'carrier-pigeon',
      }),
    ).toMatchObject({ connection: { auth: 'api-key', apiKey: 'k' } });
  });

  it('rejects an invalid stored base URL', () => {
    expect(
      errorOf(() =>
        upgradeLegacyModelParams({ source: 'user', modelString: 'openai:x', baseUrl: 'not a url' }),
      )?.code,
    ).toBe('INVALID_MODEL_SELECTION');
  });
});

describe('modelSelectionSchema', () => {
  it('requires a connection for user selections and forbids mixing auth fields', () => {
    expect(
      modelSelectionSchema.safeParse({ source: 'user', providerId: 'openai', modelId: 'x' })
        .success,
    ).toBe(false);
    expect(
      modelSelectionSchema.safeParse({
        source: 'user',
        providerId: 'openai',
        modelId: 'x',
        connection: {
          auth: 'api-key',
          apiKey: 'k',
          credentialId: '00000000-0000-4000-8000-000000000000',
        },
      }).success,
    ).toBe(false);
  });
});
