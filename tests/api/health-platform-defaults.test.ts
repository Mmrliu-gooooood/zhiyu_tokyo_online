import { beforeEach, describe, expect, it, vi } from 'vitest';

const providerConfig = vi.hoisted(() => ({
  getServerWebSearchProviders: vi.fn(),
  getServerImageProviders: vi.fn(),
  getServerVideoProviders: vi.fn(),
  getServerTTSProviders: vi.fn(),
  getPlatformDefaultCatalog: vi.fn(),
  isPlatformDefaultBackingProvider: vi.fn(),
}));

vi.mock('@/lib/server/provider-config', () => providerConfig);

import { GET } from '@/app/api/health/route';

describe('health platform default capabilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providerConfig.getServerWebSearchProviders.mockReturnValue({});
    providerConfig.getServerImageProviders.mockReturnValue({ 'minimax-image': {} });
    providerConfig.getServerVideoProviders.mockReturnValue({ 'minimax-video': {} });
    providerConfig.getServerTTSProviders.mockReturnValue({ 'minimax-tts': {} });
    providerConfig.isPlatformDefaultBackingProvider.mockImplementation(
      (_capability: string, providerId: string) => providerId.startsWith('minimax-'),
    );
  });

  it('does not re-enable disabled defaults through their legacy backing entries', async () => {
    providerConfig.getPlatformDefaultCatalog.mockReturnValue({
      version: 2,
      entries: [
        { capability: 'image', available: false },
        { capability: 'video', available: false },
        { capability: 'tts', available: false },
      ],
    });

    const response = await GET();
    const body = await response.json();

    expect(body.capabilities).toMatchObject({
      imageGeneration: false,
      videoGeneration: false,
      tts: false,
    });
  });

  it('reports an available platform default or an unrelated managed provider', async () => {
    providerConfig.getPlatformDefaultCatalog.mockReturnValue({
      version: 2,
      entries: [{ capability: 'image', available: true }],
    });
    providerConfig.getServerVideoProviders.mockReturnValue({
      'minimax-video': {},
      kling: {},
    });

    const response = await GET();
    const body = await response.json();

    expect(body.capabilities).toMatchObject({
      imageGeneration: true,
      videoGeneration: true,
      tts: false,
    });
  });
});
