import { afterEach, describe, expect, it, vi } from 'vitest';

import { generateImage } from '@/lib/media/image-providers';
import type { ImageGenerationConfig } from '@/lib/media/types';

const fetchMock = vi.fn();

function customConfig(
  protocol: 'openai-images' | 'siliconflow-images' | 'openrouter-images',
  overrides: Record<string, unknown> = {},
): ImageGenerationConfig {
  return {
    providerId: 'custom-image-test',
    apiKey: 'secret-key',
    baseUrl: 'https://media.example.com/gateway/v1///',
    model: 'vendor/custom-image-model',
    protocol,
    requiresApiKey: true,
    ...overrides,
  } as unknown as ImageGenerationConfig;
}

describe('custom image protocol dispatch', () => {
  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('maps SiliconFlow image_size and images response while preserving the base prefix', async () => {
    vi.stubGlobal('fetch', fetchMock);
    const signal = new AbortController().signal;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ images: [{ url: 'https://cdn.example.com/result.webp' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await generateImage(customConfig('siliconflow-images'), {
      prompt: 'a precise classroom diagram',
      negativePrompt: 'blurry',
      width: 1664,
      height: 928,
      signal,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://media.example.com/gateway/v1/images/generations',
      expect.objectContaining({
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer secret-key',
        },
        signal,
      }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      model: 'vendor/custom-image-model',
      prompt: 'a precise classroom diagram',
      negative_prompt: 'blurry',
      image_size: '1664x928',
    });
    expect(result).toEqual({
      url: 'https://cdn.example.com/result.webp',
      width: 1664,
      height: 928,
    });
  });

  it('maps OpenRouter base64 and media_type without sending auth when disabled', async () => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [{ b64_json: 'aW1hZ2U=', media_type: 'image/webp' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = (await generateImage(
      customConfig('openrouter-images', { apiKey: '', requiresApiKey: false }),
      { prompt: 'inline image', width: 1024, height: 768 },
    )) as unknown as { base64?: string; mimeType?: string; bytes?: Uint8Array };

    expect(fetchMock).toHaveBeenCalledWith('https://media.example.com/gateway/v1/images', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'vendor/custom-image-model',
        prompt: 'inline image',
        size: '1024x768',
      }),
      signal: undefined,
    });
    expect(result.base64).toBe('aW1hZ2U=');
    expect(result.mimeType).toBe('image/webp');
    expect(Array.from(result.bytes || [])).toEqual([105, 109, 97, 103, 101]);
  });

  it('extracts an OpenRouter data URL and rejects unsupported SVG output', async () => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ url: 'data:image/png;base64,aW1hZ2U=' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(
      generateImage(customConfig('openrouter-images'), { prompt: 'data URL' }),
    ).resolves.toEqual(expect.objectContaining({ base64: 'aW1hZ2U=', mimeType: 'image/png' }));

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: [{ b64_json: 'PHN2Zz4=', media_type: 'image/svg+xml' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await expect(
      generateImage(customConfig('openrouter-images'), { prompt: 'vector image' }),
    ).rejects.toThrow('openrouter-images returned unsupported SVG media');
  });

  it('requires an explicit custom base URL and model instead of falling back', async () => {
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      generateImage(customConfig('openai-images', { baseUrl: '' }), { prompt: 'no base' }),
    ).rejects.toThrow('openai-images requires an explicit Base URL');
    await expect(
      generateImage(customConfig('openai-images', { model: '' }), { prompt: 'no model' }),
    ).rejects.toThrow('openai-images requires an explicit model ID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes AbortSignal through the custom OpenAI-compatible request', async () => {
    vi.stubGlobal('fetch', fetchMock);
    const signal = new AbortController().signal;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ url: 'https://cdn.example.com/openai.png' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await generateImage(customConfig('openai-images'), { prompt: 'openai-compatible', signal });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://media.example.com/gateway/v1/images/generations',
      expect.objectContaining({ signal }),
    );
  });

  it('treats redirects as explicit HTTP errors without following them', async () => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValueOnce(
      new Response('redirect refused', {
        status: 302,
        headers: { Location: 'https://redirect.example.com/images' },
      }),
    );

    await expect(
      generateImage(customConfig('openai-images'), { prompt: 'do not redirect' }),
    ).rejects.toThrow('openai-images request failed (302): redirect refused');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://media.example.com/gateway/v1/images/generations',
      expect.objectContaining({ redirect: 'manual' }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('redacts credentials from explicit provider errors', async () => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValueOnce(
      new Response('invalid Bearer secret-key for request', {
        status: 401,
        headers: { 'x-request-id': 'req-safe-123' },
      }),
    );

    let error: Error | undefined;
    try {
      await generateImage(customConfig('siliconflow-images'), { prompt: 'bad auth' });
    } catch (caught) {
      error = caught as Error;
    }

    expect(error?.message).toContain('siliconflow-images request failed (401)');
    expect(error?.message).toContain('request req-safe-123');
    expect(error?.message).not.toContain('secret-key');
  });
});
