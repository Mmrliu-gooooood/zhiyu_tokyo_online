import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { generateVideo } from '@/lib/media/video-providers';
import type { VideoGenerationConfig } from '@/lib/media/types';

const fetchMock = vi.fn();

function jsonResponse(data: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function customConfig(
  protocol: 'siliconflow-video' | 'openrouter-video',
  overrides: Record<string, unknown> = {},
): VideoGenerationConfig {
  return {
    providerId: 'custom-video-test',
    apiKey: 'video-secret',
    baseUrl: 'https://video.example.com/proxy/api/v1///',
    model: 'vendor/video-model',
    protocol,
    requiresApiKey: true,
    ...overrides,
  } as unknown as VideoGenerationConfig;
}

describe('custom video protocol dispatch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('submits and polls SiliconFlow with requestId and mapped image_size', async () => {
    const signal = new AbortController().signal;
    fetchMock.mockResolvedValueOnce(jsonResponse({ requestId: 'sf-task-1' })).mockResolvedValueOnce(
      jsonResponse({
        status: 'Succeed',
        reason: '',
        results: { videos: [{ url: 'https://cdn.example.com/siliconflow.mp4' }] },
      }),
    );

    const promise = generateVideo(customConfig('siliconflow-video'), {
      prompt: 'a science animation',
      aspectRatio: '9:16',
      duration: 5,
      signal,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://video.example.com/proxy/api/v1/video/submit',
      {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer video-secret',
        },
        body: JSON.stringify({
          model: 'vendor/video-model',
          prompt: 'a science animation',
          image_size: '720x1280',
        }),
        signal,
      },
    );

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(promise).resolves.toEqual({
      url: 'https://cdn.example.com/siliconflow.mp4',
      duration: 5,
      width: 720,
      height: 1280,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://video.example.com/proxy/api/v1/video/status',
      expect.objectContaining({
        method: 'POST',
        redirect: 'manual',
        body: JSON.stringify({ requestId: 'sf-task-1' }),
        signal,
      }),
    );
  });

  it('polls OpenRouter and downloads authenticated content into bytes', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'or-job-1', status: 'pending' }, 202))
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'or-job-1',
          status: 'completed',
          unsigned_urls: ['https://untrusted.example.com/temporary.mp4'],
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([0, 1, 2, 3]), {
          status: 200,
          headers: { 'Content-Type': 'video/webm' },
        }),
      );

    const promise = generateVideo(customConfig('openrouter-video'), {
      prompt: 'an orbit animation',
      aspectRatio: '16:9',
      resolution: '1080p',
      duration: 8,
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      model: 'vendor/video-model',
      prompt: 'an orbit animation',
      duration: 8,
      resolution: '1080p',
      aspect_ratio: '16:9',
    });

    await vi.advanceTimersByTimeAsync(30_000);
    const result = (await promise) as unknown as {
      url?: string;
      bytes?: Uint8Array;
      mimeType?: string;
      duration: number;
      width: number;
      height: number;
    };

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://video.example.com/proxy/api/v1/videos',
      'https://video.example.com/proxy/api/v1/videos/or-job-1',
      'https://video.example.com/proxy/api/v1/videos/or-job-1/content?index=0',
    ]);
    expect(fetchMock.mock.calls[2][1]).toEqual(
      expect.objectContaining({
        method: 'GET',
        redirect: 'manual',
        headers: { Authorization: 'Bearer video-secret' },
      }),
    );
    expect(result.url).toBeUndefined();
    expect(Array.from(result.bytes || [])).toEqual([0, 1, 2, 3]);
    expect(result.mimeType).toBe('video/webm');
    expect(result.duration).toBe(8);
    expect(result.width).toBe(1920);
    expect(result.height).toBe(1080);
  });

  it('omits Authorization for no-auth OpenRouter deployments', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'local-job', status: 'pending' }, 202))
      .mockResolvedValueOnce(jsonResponse({ id: 'local-job', status: 'completed' }))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([9]), {
          status: 200,
          headers: { 'Content-Type': 'video/mp4' },
        }),
      );

    const promise = generateVideo(
      customConfig('openrouter-video', { apiKey: '', requiresApiKey: false }),
      { prompt: 'local video' },
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await promise;

    for (const call of fetchMock.mock.calls) {
      expect(call[1].headers).not.toHaveProperty('Authorization');
    }
  });

  it('maps terminal status errors clearly and redacts the API key', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'failed-job', status: 'pending' }, 202))
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'failed-job',
          status: 'failed',
          error: 'provider rejected video-secret',
        }),
      );

    const promise = generateVideo(customConfig('openrouter-video'), { prompt: 'will fail' });
    let error: Error | undefined;
    const rejection = promise.catch((caught: unknown) => {
      error = caught as Error;
    });
    await vi.advanceTimersByTimeAsync(30_000);

    await rejection;
    expect(error?.message).toContain('openrouter-video task failed');
    expect(error?.message).not.toContain('video-secret');
  });

  it('does not follow a redirect from OpenRouter content download', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'redirect-job', status: 'pending' }, 202))
      .mockResolvedValueOnce(jsonResponse({ id: 'redirect-job', status: 'completed' }))
      .mockResolvedValueOnce(
        new Response('redirect refused', {
          status: 307,
          headers: { Location: 'https://cdn.example.com/private-video' },
        }),
      );

    const promise = generateVideo(customConfig('openrouter-video'), {
      prompt: 'secure content',
    });
    const rejection = expect(promise).rejects.toThrow(
      'openrouter-video content failed (307): redirect refused',
    );
    await vi.advanceTimersByTimeAsync(30_000);

    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][1]).toEqual(expect.objectContaining({ redirect: 'manual' }));
  });
});
