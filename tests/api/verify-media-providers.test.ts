import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  testImageConnectivity: vi.fn(),
  testVideoConnectivity: vi.fn(),
}));

vi.mock('@/lib/media/image-providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/media/image-providers')>();
  return { ...actual, testImageConnectivity: mocks.testImageConnectivity };
});

vi.mock('@/lib/media/video-providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/media/video-providers')>();
  return { ...actual, testVideoConnectivity: mocks.testVideoConnectivity };
});

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function request(path: string, headers: Record<string, string>) {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: '{}',
  });
}

describe('provider verification model-source isolation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('ZHIYU_DEFAULTS_REVISION_SECRET', 'test-shared-revision-secret');
    mocks.testImageConnectivity.mockReset().mockResolvedValue({ success: true, message: 'ok' });
    mocks.testVideoConnectivity.mockReset().mockResolvedValue({ success: true, message: 'ok' });
  });

  it('ignores image provider, model, key, and address overrides for a platform default', async () => {
    vi.stubEnv('IMAGE_MINIMAX_API_KEY', 'platform-image-key');
    vi.stubEnv('IMAGE_MINIMAX_BASE_URL', 'https://platform.example/image/v1');
    const { POST } = await import('@/app/api/verify-image-provider/route');

    const res = await POST(
      request('/api/verify-image-provider', {
        'x-model-source': 'platform',
        'x-platform-default-id': 'zhiyu-default-image',
        'x-image-provider': 'openai-image',
        'x-image-model': 'attacker-model',
        'x-api-key': 'attacker-key',
        'x-base-url': 'https://attacker.example/v1',
      }),
    );

    expect(res.status).toBe(200);
    expect(mocks.testImageConnectivity).toHaveBeenCalledWith({
      providerId: 'minimax-image',
      model: 'image-01',
      apiKey: 'platform-image-key',
      baseUrl: 'https://platform.example/image/v1',
    });
  });

  it('does not borrow the same image vendor platform credentials for a user selection', async () => {
    vi.stubEnv('IMAGE_MINIMAX_API_KEY', 'platform-image-key');
    vi.stubEnv('IMAGE_MINIMAX_BASE_URL', 'https://platform.example/image/v1');
    const { POST } = await import('@/app/api/verify-image-provider/route');

    const res = await POST(
      request('/api/verify-image-provider', {
        'x-model-source': 'user',
        'x-image-provider': 'minimax-image',
        'x-image-model': 'image-01-live',
        'x-api-key': 'user-image-key',
        'x-base-url': 'https://user.example/image/v1',
      }),
    );

    expect(res.status).toBe(200);
    expect(mocks.testImageConnectivity).toHaveBeenCalledWith({
      providerId: 'minimax-image',
      model: 'image-01-live',
      apiKey: 'user-image-key',
      baseUrl: 'https://user.example/image/v1',
    });
  });

  it('fails a user image check with no user key even when the platform vendor is configured', async () => {
    vi.stubEnv('IMAGE_MINIMAX_API_KEY', 'platform-image-key');
    const { POST } = await import('@/app/api/verify-image-provider/route');

    const res = await POST(
      request('/api/verify-image-provider', {
        'x-model-source': 'user',
        'x-image-provider': 'minimax-image',
        'x-image-model': 'image-01',
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ errorCode: 'MISSING_API_KEY' });
    expect(mocks.testImageConnectivity).not.toHaveBeenCalled();
  });

  it('ignores video provider, model, key, and address overrides for a platform default', async () => {
    vi.stubEnv('VIDEO_MINIMAX_API_KEY', 'platform-video-key');
    vi.stubEnv('VIDEO_MINIMAX_BASE_URL', 'https://platform.example/video/v1');
    const { POST } = await import('@/app/api/verify-video-provider/route');

    const res = await POST(
      request('/api/verify-video-provider', {
        'x-model-source': 'platform',
        'x-platform-default-id': 'zhiyu-default-video',
        'x-video-provider': 'grok-video',
        'x-video-model': 'attacker-model',
        'x-api-key': 'attacker-key',
        'x-base-url': 'https://attacker.example/v1',
      }),
    );

    expect(res.status).toBe(200);
    expect(mocks.testVideoConnectivity).toHaveBeenCalledWith({
      providerId: 'minimax-video',
      model: 'MiniMax-Hailuo-2.3',
      apiKey: 'platform-video-key',
      baseUrl: 'https://platform.example/video/v1',
    });
  });

  it('does not borrow the same video vendor platform credentials for a user selection', async () => {
    vi.stubEnv('VIDEO_MINIMAX_API_KEY', 'platform-video-key');
    vi.stubEnv('VIDEO_MINIMAX_BASE_URL', 'https://platform.example/video/v1');
    const { POST } = await import('@/app/api/verify-video-provider/route');

    const res = await POST(
      request('/api/verify-video-provider', {
        'x-model-source': 'user',
        'x-video-provider': 'minimax-video',
        'x-video-model': 'MiniMax-Hailuo-02',
        'x-api-key': 'user-video-key',
        'x-base-url': 'https://user.example/video/v1',
      }),
    );

    expect(res.status).toBe(200);
    expect(mocks.testVideoConnectivity).toHaveBeenCalledWith({
      providerId: 'minimax-video',
      model: 'MiniMax-Hailuo-02',
      apiKey: 'user-video-key',
      baseUrl: 'https://user.example/video/v1',
    });
  });

  it('fails a user video check with no user key even when the platform vendor is configured', async () => {
    vi.stubEnv('VIDEO_MINIMAX_API_KEY', 'platform-video-key');
    const { POST } = await import('@/app/api/verify-video-provider/route');

    const res = await POST(
      request('/api/verify-video-provider', {
        'x-model-source': 'user',
        'x-video-provider': 'minimax-video',
        'x-video-model': 'MiniMax-Hailuo-2.3',
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ errorCode: 'MISSING_API_KEY' });
    expect(mocks.testVideoConnectivity).not.toHaveBeenCalled();
  });
});
