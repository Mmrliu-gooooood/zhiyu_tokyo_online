import { describe, expect, it } from 'vitest';
import type {
  BuiltInImageProviderId,
  BuiltInVideoProviderId,
  ImageProviderConfig,
  ImageProviderSettings,
  VideoProviderConfig,
  VideoProviderSettings,
} from '@/lib/media/types';
import {
  findImageProvider,
  findVideoProvider,
  isImageProviderAvailable,
  isVideoProviderAvailable,
  listImageProviders,
  listVideoProviders,
} from '@/lib/media/provider-catalog';

const imageBuiltIns = {
  'openai-image': {
    id: 'openai-image',
    name: 'OpenAI Image',
    requiresApiKey: true,
    models: [{ id: 'gpt-image-1', name: 'GPT Image 1' }],
    supportedAspectRatios: ['1:1'],
  },
} satisfies Partial<Record<BuiltInImageProviderId, ImageProviderConfig>>;

const videoBuiltIns = {
  seedance: {
    id: 'seedance',
    name: 'Seedance',
    requiresApiKey: true,
    models: [{ id: 'seedance-1', name: 'Seedance 1' }],
    supportedAspectRatios: ['16:9'],
  },
} satisfies Partial<Record<BuiltInVideoProviderId, VideoProviderConfig>>;

describe('image provider catalog', () => {
  const customId = 'custom-image-gateway' as const;
  const settings: Partial<Record<string, ImageProviderSettings>> = {
    'openai-image': {
      apiKey: 'built-in-key',
      baseUrl: '',
      enabled: true,
      isBuiltIn: true,
      requiresApiKey: true,
    },
    [customId]: {
      apiKey: 'custom-key',
      baseUrl: 'https://images.example/v1',
      enabled: true,
      isBuiltIn: false,
      customName: 'Image Gateway',
      protocol: 'openai-images',
      requiresApiKey: true,
      customModels: [{ id: 'image/model:1', name: 'Image Model 1' }],
    },
  };

  it('lists built-ins first and appends valid custom providers without mutating inputs', () => {
    const before = structuredClone(settings);

    expect(listImageProviders(imageBuiltIns, settings).map(({ id }) => id)).toEqual([
      'openai-image',
      customId,
    ]);
    expect(settings).toEqual(before);
  });

  it('queries custom metadata from settings', () => {
    expect(findImageProvider(customId, imageBuiltIns, settings)).toMatchObject({
      id: customId,
      name: 'Image Gateway',
      protocol: 'openai-images',
      models: [{ id: 'image/model:1', name: 'Image Model 1' }],
      requiresApiKey: true,
    });
  });

  it('keeps incomplete custom providers queryable but unavailable until configured', () => {
    const pending = {
      ...settings,
      [customId]: { ...settings[customId]!, apiKey: '', customModels: [] },
    };

    expect(findImageProvider(customId, imageBuiltIns, pending)?.id).toBe(customId);
    expect(isImageProviderAvailable(customId, imageBuiltIns, pending)).toBe(false);
    expect(isImageProviderAvailable(customId, imageBuiltIns, settings)).toBe(true);
  });

  it('rejects malformed custom IDs and unknown protocols', () => {
    const malformed = {
      ...settings,
      'custom-video-wrong-kind': settings[customId],
      'custom-image-unknown': { ...settings[customId]!, protocol: 'unknown-images' },
    } as unknown as Partial<Record<string, ImageProviderSettings>>;

    expect(listImageProviders(imageBuiltIns, malformed).map(({ id }) => id)).toEqual([
      'openai-image',
      customId,
    ]);
  });

  it('keeps the platform editable while its Base URL is cleared', () => {
    const editing = { ...settings, [customId]: { ...settings[customId]!, baseUrl: '' } };
    expect(findImageProvider(customId, imageBuiltIns, editing)?.name).toBe('Image Gateway');
    expect(isImageProviderAvailable(customId, imageBuiltIns, editing)).toBe(false);
  });
});

describe('video provider catalog', () => {
  const customId = 'custom-video-gateway' as const;
  const settings: Partial<Record<string, VideoProviderSettings>> = {
    seedance: {
      apiKey: '',
      baseUrl: '',
      enabled: false,
      isBuiltIn: true,
      requiresApiKey: true,
    },
    [customId]: {
      apiKey: '',
      baseUrl: 'http://localhost:8080/api/v1',
      enabled: true,
      isBuiltIn: false,
      customName: 'Local Video',
      protocol: 'openrouter-video',
      requiresApiKey: false,
      customModels: [{ id: 'video-1', name: 'Video 1' }],
    },
  };

  it('lists and queries a valid custom video provider', () => {
    expect(listVideoProviders(videoBuiltIns, settings).map(({ id }) => id)).toEqual([
      'seedance',
      customId,
    ]);
    expect(findVideoProvider(customId, videoBuiltIns, settings)).toMatchObject({
      name: 'Local Video',
      protocol: 'openrouter-video',
      requiresApiKey: false,
    });
  });

  it('uses explicit auth semantics and enabled state for availability', () => {
    expect(isVideoProviderAvailable(customId, videoBuiltIns, settings)).toBe(true);
    expect(
      isVideoProviderAvailable(customId, videoBuiltIns, {
        ...settings,
        [customId]: { ...settings[customId]!, enabled: false },
      }),
    ).toBe(false);
  });

  it('keeps a platform without an address visible but unavailable', () => {
    const editing = { ...settings, [customId]: { ...settings[customId]!, baseUrl: '' } };
    expect(findVideoProvider(customId, videoBuiltIns, editing)?.name).toBe('Local Video');
    expect(isVideoProviderAvailable(customId, videoBuiltIns, editing)).toBe(false);
  });
});
