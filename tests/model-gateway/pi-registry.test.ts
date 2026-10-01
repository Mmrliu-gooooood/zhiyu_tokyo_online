import { describe, expect, it } from 'vitest';
import {
  sealedAuthContext,
  ambientAuthContext,
} from '@/lib/model-gateway/credentials/auth-context';
import {
  PI_PROVIDER_IDS,
  createCallModels,
  getCustomProvider,
  loadPiProvider,
} from '@/lib/model-gateway/runtime/pi-registry';
import {
  GatewayError,
  assistantText,
  messageText,
  toolResult,
  userContent,
  userText,
} from '@/lib/model-gateway';

describe('pi registry', () => {
  it('loads every built-in pi provider listed in the loader map', { timeout: 60_000 }, async () => {
    for (const id of PI_PROVIDER_IDS) {
      const provider = await loadPiProvider(id);
      expect(provider.id).toBe(id);
    }
  });

  it('caches provider instances per process', async () => {
    expect(await loadPiProvider('deepseek')).toBe(await loadPiProvider('deepseek'));
    const a = getCustomProvider({ id: 'glm', api: 'openai-completions', baseUrl: 'https://x/v4' });
    expect(
      getCustomProvider({ id: 'glm', api: 'openai-completions', baseUrl: 'https://x/v4' }),
    ).toBe(a);
    expect(
      getCustomProvider({ id: 'glm', api: 'openai-completions', baseUrl: 'https://y/v4' }),
    ).not.toBe(a);
  });

  it('rejects unknown pi provider ids', async () => {
    await expect(loadPiProvider('not-a-provider')).rejects.toThrow('Unknown pi provider');
  });

  it('per-call Models views resolve only the request key, never ambient env', async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-env-should-not-resolve';
    try {
      const models = createCallModels(await loadPiProvider('deepseek'), sealedAuthContext());
      expect(await models.getAuth('deepseek')).toBeUndefined();
      expect(await models.getAuth('deepseek', { apiKey: 'sk-request' })).toMatchObject({
        auth: { apiKey: 'sk-request' },
      });
    } finally {
      delete process.env.DEEPSEEK_API_KEY;
    }
  });

  it('ambient contexts expose only the allowed prefixes', async () => {
    const ctx = ambientAuthContext(['AWS_'], { AWS_REGION: 'us-west-2', OPENAI_API_KEY: 'sk' });
    expect(await ctx.env('AWS_REGION')).toBe('us-west-2');
    expect(await ctx.env('OPENAI_API_KEY')).toBeUndefined();
    expect(await sealedAuthContext().env('AWS_REGION')).toBeUndefined();
  });
});

describe('message constructors and errors', () => {
  it('builds pi messages with timestamps and image parts', () => {
    expect(userText('hi', 1)).toEqual({ role: 'user', content: 'hi', timestamp: 1 });
    expect(
      userContent('see', ['data:image/png;base64,QUJD', 'https://a.example/b.png'], 2),
    ).toEqual({
      role: 'user',
      timestamp: 2,
      content: [
        { type: 'text', text: 'see' },
        { type: 'image', mimeType: 'image/png', data: 'QUJD' },
        { type: 'image_url', url: 'https://a.example/b.png' },
      ],
    });
    const assistant = assistantText(
      'done',
      { provider: 'deepseek', api: 'openai-completions', model: 'm' },
      3,
    );
    expect(messageText(assistant)).toBe('done');
    expect(toolResult({ id: 'c1', name: 'lookup' }, 'ok', { timestamp: 4 })).toEqual({
      role: 'toolResult',
      toolCallId: 'c1',
      toolName: 'lookup',
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
      timestamp: 4,
    });
  });

  it('GatewayError carries sanitized fixed messages and serializes without its cause', () => {
    const error = new GatewayError('MODEL_UPSTREAM_UNAVAILABLE', {
      providerId: 'p',
      modelId: 'm',
      status: 503,
      cause: new Error('upstream body with secret sk-123'),
    });
    expect(error.message).toBe('The model provider is unavailable.');
    expect(JSON.stringify(error)).not.toContain('sk-123');
    expect(error.statusCode).toBe(503);
  });
});
