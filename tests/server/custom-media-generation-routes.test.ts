import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  generateImage: vi.fn(),
  generateVideo: vi.fn(),
  usage: vi.fn(),
}));

vi.mock('@/lib/server/generation-jobs/route-guard', () => ({
  guardClientGeneration: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/server/usage-storage', () => ({ recordGenerationUsage: mocks.usage }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/lib/server/ssrf-guard', () => ({ validateUrlForSSRF: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/server/provider-config', () => ({
  isServerConfiguredProvider: vi.fn().mockReturnValue(false),
  isServerProviderDisabled: vi.fn().mockReturnValue(false),
  resolveImageApiKey: vi.fn(),
  resolveImageBaseUrl: vi.fn(),
  resolveImageModel: vi.fn(),
  resolveServerImageProviderId: vi.fn(),
  resolveVideoApiKey: vi.fn(),
  resolveVideoBaseUrl: vi.fn(),
  resolveVideoModel: vi.fn(),
  resolveServerVideoProviderId: vi.fn(),
}));
vi.mock('@/lib/media/image-providers', () => ({
  IMAGE_PROVIDERS: {},
  aspectRatioToDimensions: () => ({ width: 1024, height: 1024 }),
  generateImage: mocks.generateImage,
  testImageConnectivity: vi.fn(),
}));
vi.mock('@/lib/media/video-providers', () => ({
  generateVideo: mocks.generateVideo,
  normalizeVideoOptions: (_providerId: string, options: unknown) => options,
  testVideoConnectivity: vi.fn(),
}));

function request(path: string, providerHeader: string, body: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...JSON.parse(providerHeader) },
    body: JSON.stringify(body),
  });
}

describe('custom media generation routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generateImage.mockResolvedValue({ base64: 'aW1hZ2U=', width: 1024, height: 1024 });
    mocks.generateVideo.mockResolvedValue({
      url: 'https://cdn.example.com/video.mp4',
      width: 1280,
      height: 720,
      duration: 5,
    });
  });

  it('uses the complete custom image config instead of server defaults', async () => {
    const { POST } = await import('@/app/api/generate/image/route');
    const response = await POST(
      request(
        '/api/generate/image',
        '{"x-image-provider":"custom-image-team","x-image-model":"vendor/image"}',
        {
          prompt: 'diagram',
          providerConfig: {
            id: 'custom-image-team',
            protocol: 'siliconflow-images',
            apiKey: 'secret',
            baseUrl: 'https://gateway.example.com/team/v1/',
            enabled: true,
            requiresApiKey: true,
            modelId: 'vendor/image',
          },
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'custom-image-team',
        protocol: 'siliconflow-images',
        baseUrl: 'https://gateway.example.com/team/v1',
        model: 'vendor/image',
        apiKey: 'secret',
      }),
      expect.objectContaining({ prompt: 'diagram' }),
    );
  });

  it('rejects a mismatched video instance without calling a provider', async () => {
    const { POST } = await import('@/app/api/generate/video/route');
    const response = await POST(
      request(
        '/api/generate/video',
        '{"x-video-provider":"custom-video-team","x-video-model":"vendor/video"}',
        {
          prompt: 'clip',
          providerConfig: {
            id: 'custom-video-other',
            protocol: 'openrouter-video',
            apiKey: 'secret',
            baseUrl: 'https://openrouter.ai/api/v1',
            enabled: true,
            modelId: 'vendor/video',
          },
        },
      ),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ errorCode: 'PROVIDER_CONFIG_ID_MISMATCH' });
    expect(mocks.generateVideo).not.toHaveBeenCalled();
  });

  it('validates a custom image configuration without starting paid generation', async () => {
    const { POST } = await import('@/app/api/verify-image-provider/route');
    const response = await POST(
      request(
        '/api/verify-image-provider',
        '{"x-image-provider":"custom-image-team","x-image-model":"vendor/image"}',
        {
          providerConfig: {
            id: 'custom-image-team',
            protocol: 'openai-images',
            apiKey: 'secret',
            baseUrl: 'https://gateway.example.com/v1',
            enabled: true,
            requiresApiKey: true,
            modelId: 'vendor/image',
          },
        },
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      verification: 'configuration',
    });
    expect(mocks.generateImage).not.toHaveBeenCalled();
  });

  it('rejects an incomplete custom video verification config', async () => {
    const { POST } = await import('@/app/api/verify-video-provider/route');
    const response = await POST(
      request(
        '/api/verify-video-provider',
        '{"x-video-provider":"custom-video-team","x-video-model":"vendor/video"}',
        { providerConfig: { protocol: 'openrouter-video' } },
      ),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ errorCode: 'INVALID_PROVIDER_CONFIG' });
    expect(mocks.generateVideo).not.toHaveBeenCalled();
  });
});
