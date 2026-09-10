import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GenerationInputSchema } from '@/lib/server/generation-jobs/contracts';

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  model: vi.fn(),
  loadBlob: vi.fn(),
  loadAsset: vi.fn(),
}));
vi.mock('@/lib/store/settings', () => ({ useSettingsStore: { getState: mocks.settings } }));
vi.mock('@/lib/utils/model-config', () => ({ getCurrentModelConfig: mocks.model }));
vi.mock('@/lib/utils/image-storage', () => ({ loadDocumentBlob: mocks.loadBlob }));
vi.mock('@/lib/media/resolve-stored-bytes', () => ({ resolveStoredBytes: mocks.loadAsset }));
vi.mock('@/lib/orchestration/registry/store', () => ({
  useAgentRegistry: {
    getState: () => ({
      listAgents: () => [],
      getAgent: () => ({
        id: 'teacher',
        name: 'Teacher',
        role: 'teacher',
        persona: 'Teach carefully',
        avatar: 'T',
        color: '#123456',
        priority: 1,
      }),
    }),
  },
}));
import { buildGenerationJobInput } from '@/lib/generation/session-input';

const settings = {
  selectedAgentIds: ['teacher'],
  agentMode: 'preset',
  agentVoiceOverrides: {},
  reviewOutlineEnabled: true,
  imageGenerationEnabled: false,
  imageProviderId: 'openai',
  imageModelId: 'gpt-image-1',
  videoGenerationEnabled: false,
  videoProviderId: 'seedance',
  videoModelId: 'seedance-1',
  webSearchProviderId: 'tavily',
  webSearchProvidersConfig: { tavily: {} },
  ttsEnabled: true,
  ttsProviderId: 'browser-native-tts',
  ttsProvidersConfig: { 'browser-native-tts': {} },
  ttsVoice: 'default',
  ttsSpeed: 1,
};
const session = {
  sessionId: 'session-1',
  requirements: { requirement: 'Physics', interactiveMode: true },
  pdfText: '',
  currentStep: 'generating' as const,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings.mockReturnValue(settings);
  mocks.model.mockReturnValue({ modelString: 'openai:gpt-4.1', apiKey: '', baseUrl: '' });
});
afterEach(() => vi.unstubAllGlobals());

describe('background session input', () => {
  it('does not submit the legacy fixed agent count for a new automatic roster', async () => {
    const automaticSettings = {
      ...settings,
      agentMode: 'auto',
    };
    Object.defineProperty(automaticSettings, 'autoAgentCount', {
      get: () => {
        throw new Error('legacy autoAgentCount must not be read');
      },
    });
    mocks.settings.mockReturnValue(automaticSettings);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === '/api/agent/media-config-snapshots'
          ? Response.json({ ref: { id: crypto.randomUUID(), revision: 1 } })
          : Response.json({ jobs: [] }),
      ),
    );

    const input = await buildGenerationJobInput(
      session,
      'zh-CN',
      new AbortController().signal,
      vi.fn(),
    );

    expect(input.agents).toEqual({ mode: 'generate' });
    expect(JSON.stringify(input)).not.toContain('autoAgentCount');
  });

  it.each([
    { providerId: 'brave', config: { apiKey: '', baseUrl: 'https://search.brave.com' } },
    { providerId: 'tavily', config: { apiKey: 'client-search-key', baseUrl: '' } },
    {
      providerId: 'doubao',
      config: {
        apiKey: 'stale-client-search-key',
        baseUrl: 'https://open.feedcoopapi.com',
        isServerConfigured: true,
      },
    },
  ])(
    'accepts the effective server search configuration for $providerId',
    async ({ providerId, config }) => {
      mocks.settings.mockReturnValue({
        ...settings,
        webSearchProviderId: providerId,
        webSearchProvidersConfig: { [providerId]: config },
      });
      const ref = { id: crypto.randomUUID(), revision: 1 };
      const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === '/api/generate-classroom/search-snapshots') {
          expect(JSON.parse(String(init?.body))).toMatchObject({
            version: 1,
            providerId,
            apiKey: config.apiKey,
            baseUrl: config.baseUrl,
          });
          return Response.json({ ref });
        }
        return url === '/api/agent/media-config-snapshots'
          ? Response.json({ ref: { id: crypto.randomUUID(), revision: 1 } })
          : Response.json({ jobs: [] });
      });
      vi.stubGlobal('fetch', fetchMock);

      const input = await buildGenerationJobInput(
        { ...session, requirements: { ...session.requirements, webSearch: true } },
        'zh-CN',
        new AbortController().signal,
        vi.fn(),
      );

      expect(GenerationInputSchema.safeParse(input).success).toBe(true);
      expect(input.enableWebSearch).toBe(true);
      expect(input.webSearch).toEqual({ providerId });
      expect(input.searchConfigRef).toEqual(ref);
      expect(JSON.stringify(input)).not.toContain('stale-client-search-key');
      expect(JSON.stringify(input)).not.toContain('client-search-key');
      expect(JSON.stringify(input)).not.toContain('baseUrl');
      expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/generate-classroom');
    },
  );

  it('ignores unused document and search credentials for a text-only course', async () => {
    mocks.settings.mockReturnValue({
      ...settings,
      webSearchProvidersConfig: { tavily: { apiKey: 'unused-search-key' } },
    });
    const fetchMock = vi
      .fn()
      .mockImplementation(async (url: string) =>
        url === '/api/agent/media-config-snapshots'
          ? Response.json({ ref: { id: crypto.randomUUID(), revision: 1 } })
          : Response.json({ jobs: [] }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const input = await buildGenerationJobInput(
      { ...session, pdfProviderConfig: { apiKey: 'unused-pdf-key' } },
      'zh-CN',
      new AbortController().signal,
      vi.fn(),
    );
    expect(input.searchConfigRef).toBeUndefined();
    expect(fetchMock.mock.calls.map((call) => call[0])).not.toContain(
      '/api/generate-classroom/search-snapshots',
    );
    expect(JSON.stringify(input)).not.toContain('unused-');
  });

  it('transfers source bytes into the signed owner scope before submitting generation', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/assets')) {
        return Response.json({
          success: true,
          assetId: 'owned-source',
          revision: 1,
          digest: 'a'.repeat(64),
        });
      }
      if (url === '/api/agent/media-config-snapshots') {
        return Response.json({ id: 'ignored', ref: { id: crypto.randomUUID(), revision: 1 } });
      }
      return Response.json({ jobs: [] });
    });
    vi.stubGlobal('fetch', fetchMock);
    mocks.loadAsset.mockResolvedValue(new Blob(['lesson material'], { type: 'text/plain' }));
    const onAsset = vi.fn();
    const input = await buildGenerationJobInput(
      {
        ...session,
        documentSources: [
          {
            id: 'source',
            name: 'lesson.txt',
            size: 15,
            order: 0,
            storageKey: 'local',
            assetId: 'shared-source',
            providerId: 'pdfjs',
          },
        ],
      },
      'zh-CN',
      new AbortController().signal,
      onAsset,
    );
    expect(GenerationInputSchema.safeParse(input).success).toBe(true);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/api/generate-classroom',
      '/api/agent/media-config-snapshots',
      '/api/generate-classroom/assets',
    ]);
    expect(input.materials?.sources?.[0]).toEqual({
      assetId: 'owned-source',
      revision: 1,
      digest: 'a'.repeat(64),
      name: 'lesson.txt',
      providerId: 'pdfjs',
    });
    expect(input.requirements.interactiveMode).toBe(true);
    expect(input.tts?.providerId).toBe('browser-native-tts');
    expect(onAsset).toHaveBeenCalledTimes(1);
  });
  it('binds client model credentials through an opaque worker snapshot reference', async () => {
    const ref = { id: '123e4567-e89b-42d3-a456-426614174099', revision: 1 };
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/generate-classroom') return Response.json({ jobs: [] });
      if (url === '/api/generate-classroom/model-snapshots') {
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          modelString: 'openai:gpt-4.1',
          apiKey: 'test-client-credential',
        });
        return Response.json({ ref });
      }
      if (url === '/api/agent/media-config-snapshots') {
        return Response.json({ ref: { id: crypto.randomUUID(), revision: 1 } });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    mocks.model.mockReturnValue({
      modelString: 'openai:gpt-4.1',
      apiKey: 'test-client-credential',
      baseUrl: '',
    });
    const input = await buildGenerationJobInput(
      session,
      'zh-CN',
      new AbortController().signal,
      vi.fn(),
    );
    expect(input.modelConfigRef).toEqual(ref);
    expect(JSON.stringify(input)).not.toContain('test-client-credential');
  });
  it('reuses already-uploaded owner assets after a lost create response', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async (url: string) =>
        url === '/api/agent/media-config-snapshots'
          ? Response.json({ ref: { id: crypto.randomUUID(), revision: 1 } })
          : Response.json({ jobs: [] }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const input = await buildGenerationJobInput(
      {
        ...session,
        documentSources: [
          { id: 'source', name: 'lesson.txt', size: 15, order: 0, storageKey: 'local' },
        ],
        backgroundAssets: {
          'source:source': { assetId: 'owned-source', revision: 1, digest: 'a'.repeat(64) },
        },
      },
      'zh-CN',
      new AbortController().signal,
      vi.fn(),
    );
    expect(input.materials?.sources?.[0].assetId).toBe('owned-source');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mocks.loadBlob).not.toHaveBeenCalled();
    expect(mocks.loadAsset).not.toHaveBeenCalled();
  });

  it('binds custom media through an opaque encrypted snapshot reference', async () => {
    mocks.settings.mockReturnValue({
      ...settings,
      imageGenerationEnabled: true,
      imageProviderId: 'custom-image-team',
      imageModelId: 'image-v1',
      imageProvidersConfig: {
        'custom-image-team': {
          apiKey: 'client-secret',
          baseUrl: 'https://media.example.test/v1',
          enabled: true,
          protocol: 'openai-images',
          requiresApiKey: true,
        },
      },
    });
    const ref = { id: '123e4567-e89b-42d3-a456-426614174000', revision: 1 };
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/generate-classroom') return Response.json({ jobs: [] });
      if (url === '/api/agent/media-config-snapshots') {
        const request = JSON.parse(String(init?.body));
        expect(request.snapshot.image).toMatchObject({
          providerId: 'custom-image-team',
          protocol: 'openai-images',
          apiKey: 'client-secret',
          modelId: 'image-v1',
        });
        return Response.json({ ref });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const input = await buildGenerationJobInput(
      session,
      'zh-CN',
      new AbortController().signal,
      vi.fn(),
    );

    expect(input.mediaConfigRef).toEqual(ref);
    expect(JSON.stringify(input)).not.toContain('client-secret');
  });

  it('binds built-in media credentials through the same opaque snapshot', async () => {
    mocks.settings.mockReturnValue({
      ...settings,
      ttsProviderId: 'minimax-tts',
      ttsVoice: 'male-qn-qingse',
      ttsProvidersConfig: {
        'minimax-tts': {
          apiKey: 'built-in-secret',
          baseUrl: '',
          enabled: true,
          modelId: 'speech-2.8-hd',
        },
      },
    });
    const ref = { id: '123e4567-e89b-42d3-a456-426614174001', revision: 1 };
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/generate-classroom') return Response.json({ jobs: [] });
      if (url === '/api/agent/media-config-snapshots') {
        const request = JSON.parse(String(init?.body));
        expect(request.snapshot).toMatchObject({
          version: 2,
          ttsDefault: {
            providerId: 'minimax-tts',
            modelId: 'speech-2.8-hd',
            voiceId: 'male-qn-qingse',
          },
        });
        expect(request.snapshot.ttsProviders[0]).toMatchObject({
          providerId: 'minimax-tts',
          apiKey: 'built-in-secret',
          modelId: 'speech-2.8-hd',
        });
        expect(request.snapshot.ttsVoiceDirectory[0]).toMatchObject({
          providerId: 'minimax-tts',
          modelId: 'speech-2.8-hd',
          voiceIds: expect.arrayContaining(['male-qn-qingse']),
        });
        return Response.json({ ref });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const input = await buildGenerationJobInput(
      session,
      'zh-CN',
      new AbortController().signal,
      vi.fn(),
    );

    expect(input.mediaConfigRef).toEqual(ref);
    expect(JSON.stringify(input)).not.toContain('built-in-secret');
  });
});
