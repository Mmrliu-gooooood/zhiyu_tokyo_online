import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseGenerationInput } from '@/lib/server/generation-jobs/contracts';

const mocks = vi.hoisted(() => ({ failModel: false }));
vi.mock('@/lib/server/resolve-model', () => ({
  getModelResolutionError: () => undefined,
  resolveModel: async () => ({
    providerId: 'openai',
    modelId: 'test',
    apiKey: mocks.failModel ? '' : 'test-key',
  }),
}));
vi.mock('@/lib/server/provider-config', () => ({
  getServerProviders: () => ({ openai: { models: ['test'] } }),
  getServerTTSProviders: () => ({}),
  getServerImageProviders: () => ({}),
  getServerVideoProviders: () => ({}),
  getServerWebSearchProviders: () => ({}),
  isServerProviderDisabled: () => false,
}));

import { validateBackgroundProviders } from '@/lib/server/generation-jobs/preflight';

describe('generation preflight capability diagnostics', () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    mocks.failModel = false;
    vi.stubEnv('ASSET_S3_BUCKET', '');
  });

  it.each([
    [
      { tts: { enabled: true, providerId: 'minimax-tts', modelId: 'speech-2.8-turbo' } },
      'BACKGROUND_TTS_PROVIDER_UNAVAILABLE',
    ],
    [{ enableImageGeneration: true }, 'BACKGROUND_IMAGE_PROVIDER_UNAVAILABLE'],
    [{ enableVideoGeneration: true }, 'BACKGROUND_VIDEO_PROVIDER_UNAVAILABLE'],
    [
      { enableWebSearch: true, webSearch: { providerId: 'tavily' } },
      'BACKGROUND_SEARCH_PROVIDER_UNAVAILABLE',
    ],
  ])(
    'reports the rejected capability without exposing credentials: %s',
    async (capability, code) => {
      const input = parseGenerationInput({
        version: 1,
        requirements: { requirement: '布迪厄思想' },
        ...capability,
      });
      await expect(validateBackgroundProviders(input)).rejects.toMatchObject({
        code,
        httpStatus: 422,
      });
    },
  );

  it('distinguishes a missing text model credential from enabled media or search', async () => {
    mocks.failModel = true;
    const input = parseGenerationInput({
      version: 1,
      requirements: { requirement: '布迪厄思想', webSearch: true },
    });
    await expect(validateBackgroundProviders(input)).rejects.toMatchObject({
      code: 'BACKGROUND_MODEL_PROVIDER_UNAVAILABLE',
      httpStatus: 422,
    });
  });

  it('accepts the shared S3 asset backend used by hosted workers', async () => {
    vi.stubEnv('ASSET_S3_BUCKET', 'zhiyu-assets');
    const input = parseGenerationInput({
      version: 1,
      requirements: { requirement: '同分母分数相加' },
    });
    await expect(validateBackgroundProviders(input)).resolves.toBeUndefined();
  });
});
