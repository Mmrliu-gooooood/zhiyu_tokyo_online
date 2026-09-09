import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateText } from 'ai';
import { getModel } from '@/lib/ai/providers';

describe('saved PRO model wire dialect', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(['openai-completions', 'openai-responses'] as const)(
    'revalidates and refuses redirects for %s',
    async (api) => {
      const validateRequestUrl = vi.fn(async () => undefined);
      const fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { message: 'invalid key', type: 'authentication_error' } }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          ),
      );
      vi.stubGlobal('fetch', fetch);
      const { model } = getModel({
        providerId: 'custom-test',
        providerType: 'openai',
        modelId: 'custom',
        apiKey: 'test',
        baseUrl: 'https://gateway.example/v1',
        api,
        validateRequestUrl,
      });
      await expect(generateText({ model, prompt: 'hello', maxRetries: 0 })).rejects.toThrow();
      expect(validateRequestUrl).toHaveBeenCalledWith(
        expect.stringContaining(api === 'openai-responses' ? '/responses' : '/chat/completions'),
      );
      expect(fetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ redirect: 'error' }),
      );
    },
  );
  it('uses the requested dialect for native and custom OpenAI models', () => {
    const native = getModel({
      providerId: 'openai',
      modelId: 'gpt-5.6',
      apiKey: 'test',
      api: 'openai-completions',
    });
    expect(typeof native.model === 'string' ? native.model : native.model.provider).toBe(
      'openai.chat',
    );
    const custom = getModel({
      providerId: 'custom-test',
      providerType: 'openai',
      modelId: 'custom',
      apiKey: 'test',
      baseUrl: 'https://gateway.example/v1',
      api: 'openai-responses',
    });
    expect(typeof custom.model === 'string' ? custom.model : custom.model.provider).toBe(
      'custom-test.responses',
    );
  });
});
