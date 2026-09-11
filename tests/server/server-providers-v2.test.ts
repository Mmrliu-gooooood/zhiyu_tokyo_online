import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/server/provider-config', () => ({
  getServerProviders: () => ({ deepseek: { models: ['deepseek-flash'] }, openai: {} }),
  getServerTTSProviders: () => ({ 'minimax-tts': {}, 'openai-tts': {} }),
  getServerASRProviders: () => ({}),
  getServerPDFProviders: () => ({}),
  getServerImageProviders: () => ({ 'minimax-image': {}, seedream: {} }),
  getServerVideoProviders: () => ({ 'minimax-video': {}, kling: {} }),
  getServerWebSearchProviders: () => ({}),
  getParallelSceneConcurrency: () => 0,
  getPlatformDefaultCatalog: () => ({
    version: 2,
    entries: [
      {
        defaultId: 'zhiyu-default-text',
        capability: 'text',
        providerId: 'deepseek',
        providerName: 'DeepSeek',
        modelId: 'deepseek-flash',
        displayName: 'DeepSeek V4.1 Flash',
        available: true,
        status: 'available',
        revision: 'r1',
        parameters: {},
      },
    ],
  }),
  isPlatformDefaultBackingProvider: (section: string, providerId: string) =>
    ({
      providers: 'deepseek',
      image: 'minimax-image',
      video: 'minimax-video',
      tts: 'minimax-tts',
    })[section] === providerId,
}));

vi.mock('@/lib/server/generation-jobs/runtime', () => ({
  backgroundGenerationEnabled: () => false,
  generationReadiness: vi.fn(),
}));

describe('GET /api/server-providers catalogVersion=2', () => {
  it('separates platform defaults from editable user provider entries', async () => {
    const { GET } = await import('@/app/api/server-providers/route');
    const response = await GET(
      new NextRequest('http://localhost/api/server-providers?catalogVersion=2'),
    );
    const body = await response.json();

    expect(body.platformDefaults.version).toBe(2);
    expect(body.providers).toEqual({ openai: {} });
    expect(body.image).toEqual({ seedream: {} });
    expect(body.video).toEqual({ kling: {} });
    expect(body.tts).toEqual({ 'openai-tts': {} });
  });

  it('keeps the legacy managed-provider view for old clients', async () => {
    const { GET } = await import('@/app/api/server-providers/route');
    const response = await GET(new NextRequest('http://localhost/api/server-providers'));
    const body = await response.json();

    expect(body.platformDefaults).toBeUndefined();
    expect(body.providers.deepseek).toBeDefined();
    expect(body.image['minimax-image']).toBeDefined();
  });
});
