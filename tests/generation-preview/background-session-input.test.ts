import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GenerationInputSchema } from '@/lib/server/generation-jobs/contracts';

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  model: vi.fn(),
  refreshModel: vi.fn(),
  loadBlob: vi.fn(),
  loadAsset: vi.fn(),
}));
vi.mock('@/lib/store/settings', () => ({ useSettingsStore: { getState: mocks.settings } }));
vi.mock('@/lib/utils/model-config', () => ({
  getCurrentModelConfig: mocks.model,
  refreshPlatformModelConfig: mocks.refreshModel,
}));
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
  it('keeps an explicit personal role voice separate from the same-provider platform narrator', async () => {
    const override = {
      source: 'user',
      providerId: 'minimax-tts',
      modelId: 'speech-2.8-turbo',
      voiceId: 'female-yujie',
    };
    mocks.settings.mockReturnValue({
      ...settings,
      ttsProviderId: 'minimax-tts',
      ttsSelection: { source: 'platform', defaultId: 'zhiyu-default-tts' },
      ttsVoice: 'male-qn-qingse',
      ttsProvidersConfig: {
        'minimax-tts': { enabled: true, modelId: 'speech-2.8-turbo', apiKey: 'test-personal-key' },
      },
      platformDefaults: {
        entries: [
          {
            capability: 'tts',
            defaultId: 'zhiyu-default-tts',
            revision: 'current-tts',
            providerId: 'minimax-tts',
            modelId: 'speech-2.8-turbo',
            available: true,
          },
        ],
      },
      agentVoiceOverrides: { teacher: override },
    });
    let snapshot: { ttsProviders: Array<Record<string, unknown>>; ttsDefault: unknown } | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/agent/media-config-snapshots') {
          snapshot = JSON.parse(String(init?.body)).snapshot;
          return Response.json({ ref: { id: crypto.randomUUID(), revision: 1 } });
        }
        return Response.json({ jobs: [] });
      }),
    );

    const input = await buildGenerationJobInput(
      session,
      'zh-CN',
      new AbortController().signal,
      vi.fn(),
    );

    expect(snapshot?.ttsProviders).toHaveLength(2);
    expect(snapshot?.ttsProviders.find((provider) => provider.source === 'user')).toMatchObject({
      providerId: 'minimax-tts',
      modelId: 'speech-2.8-turbo',
      apiKey: 'test-personal-key',
    });
    expect(
      snapshot?.ttsProviders.find((provider) => provider.source === 'platform'),
    ).not.toHaveProperty('apiKey');
    expect(snapshot?.ttsDefault).toMatchObject({
      source: 'platform',
      defaultId: 'zhiyu-default-tts',
      voiceId: 'male-qn-qingse',
    });
    expect(input.tts?.agentVoiceOverrides?.teacher).toEqual(override);
    expect(input.agents?.items?.[0]?.voiceConfig).toEqual(override);
    expect(JSON.stringify(input)).not.toContain('test-personal-key');
  });
  it('preserves a platform role voice when the global narrator uses a custom provider', async () => {
    const override = {
      source: 'platform',
      defaultId: 'zhiyu-default-tts',
      revision: 'current-tts',
      providerId: 'minimax-tts',
      modelId: 'speech-2.8-turbo',
      voiceId: 'male-qn-qingse',
    };
    const userSettings = {
      ...settings,
      ttsProviderId: 'custom-tts-narrator',
      ttsSelection: { source: 'user', providerId: 'custom-tts-narrator', modelId: 'custom-speech' },
      ttsVoice: 'custom-voice',
      ttsProvidersConfig: {
        'custom-tts-narrator': {
          protocol: 'openai-speech',
          modelId: 'custom-speech',
          enabled: true,
          apiKey: 'test-custom-key',
          baseUrl: 'https://speech.example.test/v1',
        },
        'minimax-tts': { modelId: 'speech-2.8-turbo', apiKey: 'must-not-be-platform-key' },
      },
      platformDefaults: {
        entries: [
          {
            capability: 'tts',
            defaultId: 'zhiyu-default-tts',
            revision: 'current-tts',
            providerId: 'minimax-tts',
            modelId: 'speech-2.8-turbo',
            available: true,
          },
        ],
      },
      agentVoiceOverrides: { teacher: override },
    };
    mocks.settings.mockReturnValue(userSettings);
    let snapshot:
      | { ttsProviders: unknown[]; ttsVoiceDirectory: unknown[]; ttsDefault: unknown }
      | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/agent/media-config-snapshots') {
          snapshot = JSON.parse(String(init?.body)).snapshot;
          return Response.json({ ref: { id: crypto.randomUUID(), revision: 1 } });
        }
        return Response.json({ jobs: [] });
      }),
    );

    const input = await buildGenerationJobInput(
      session,
      'zh-CN',
      new AbortController().signal,
      vi.fn(),
    );

    expect(snapshot?.ttsProviders).toContainEqual({
      source: 'platform',
      defaultId: 'zhiyu-default-tts',
      revision: 'current-tts',
      speed: 1,
    });
    expect(snapshot?.ttsVoiceDirectory).toContainEqual(
      expect.objectContaining({
        source: 'platform',
        defaultId: 'zhiyu-default-tts',
        revision: 'current-tts',
        voiceIds: expect.arrayContaining(['male-qn-qingse']),
      }),
    );
    expect(snapshot?.ttsDefault).toMatchObject({
      source: 'user',
      providerId: 'custom-tts-narrator',
    });
    expect(JSON.stringify(snapshot)).not.toContain('must-not-be-platform-key');
    expect(input.tts?.agentVoiceOverrides?.teacher).toEqual(override);
    expect(input.agents?.items?.[0]?.voiceConfig).toEqual(override);
    expect(userSettings.agentVoiceOverrides.teacher).toEqual(override);
    expect(GenerationInputSchema.safeParse(input).success).toBe(true);
  });
  it('refreshes explicitly selected platform role voices when freezing a new course', async () => {
    const override = {
      source: 'platform',
      defaultId: 'zhiyu-default-tts',
      revision: 'old-tts',
      providerId: 'minimax-tts',
      modelId: 'speech-2.8-turbo',
      voiceId: 'male-qn-qingse',
    };
    mocks.settings.mockReturnValue({
      ...settings,
      ttsProviderId: 'minimax-tts',
      ttsSelection: { source: 'platform', defaultId: 'zhiyu-default-tts' },
      ttsVoice: 'male-qn-qingse',
      ttsProvidersConfig: { 'minimax-tts': { modelId: 'speech-2.8-turbo' } },
      platformDefaults: {
        entries: [
          {
            capability: 'tts',
            defaultId: 'zhiyu-default-tts',
            revision: 'new-tts',
            providerId: 'minimax-tts',
            modelId: 'speech-2.8-turbo',
            available: true,
          },
        ],
      },
      agentVoiceOverrides: { teacher: override },
    });
    let mediaSnapshot: { ttsProviders: Array<{ revision: string }> } | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/agent/media-config-snapshots') {
          mediaSnapshot = JSON.parse(String(init?.body)).snapshot;
          return Response.json({ ref: { id: crypto.randomUUID(), revision: 1 } });
        }
        return Response.json({ jobs: [] });
      }),
    );

    const input = await buildGenerationJobInput(
      session,
      'zh-CN',
      new AbortController().signal,
      vi.fn(),
    );

    expect(input.tts?.agentVoiceOverrides?.teacher).toMatchObject({
      revision: mediaSnapshot?.ttsProviders[0].revision,
    });
    expect(input.agents?.items?.[0]?.voiceConfig).toMatchObject({
      source: 'platform',
      revision: 'new-tts',
      voiceId: 'male-qn-qingse',
    });
    expect(override.revision).toBe('old-tts');
  });
  it.each(['preset', 'auto'])(
    'does not submit unused persisted role voice overrides for %s rosters',
    async (agentMode) => {
      const unusedVoice = {
        providerId: 'custom-tts-retired',
        modelId: 'old-model',
        voiceId: 'old-voice',
        source: 'user',
      };
      const agentVoiceOverrides = {
        'not-selected': unusedVoice,
        ...(agentMode === 'auto' ? { teacher: unusedVoice } : {}),
      };
      mocks.settings.mockReturnValue({ ...settings, agentMode, agentVoiceOverrides });
      let snapshot: Record<string, unknown> | undefined;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          if (url === '/api/agent/media-config-snapshots') {
            snapshot = JSON.parse(String(init?.body)).snapshot;
            return Response.json({ ref: { id: crypto.randomUUID(), revision: 1 } });
          }
          return Response.json({ jobs: [] });
        }),
      );

      const input = await buildGenerationJobInput(
        session,
        'zh-CN',
        new AbortController().signal,
        vi.fn(),
      );

      expect(input.tts?.agentVoiceOverrides).toEqual({});
      expect(JSON.stringify(snapshot)).not.toContain('custom-tts-retired');
      expect(agentVoiceOverrides['not-selected']).toEqual(unusedVoice);
    },
  );
  it('freezes the refreshed platform revision alongside the accepted model snapshot', async () => {
    const model = {
      source: 'platform',
      defaultId: 'zhiyu-default-text',
      revision: 'old',
      modelString: '',
      apiKey: '',
      baseUrl: '',
    };
    mocks.model.mockReturnValue(model);
    const mediaSettings = (revision: string) => ({
      ...settings,
      imageGenerationEnabled: true,
      imageProviderId: 'minimax-image',
      imageModelId: 'image-01',
      imageProvidersConfig: { 'minimax-image': {} },
      imageSelection: { source: 'platform', defaultId: 'zhiyu-default-image' },
      platformDefaults: { entries: [{ defaultId: 'zhiyu-default-image', revision }] },
    });
    mocks.settings.mockReturnValue(mediaSettings('old-image'));
    mocks.refreshModel.mockImplementation(async () => {
      mocks.settings.mockReturnValue(mediaSettings('new-image'));
      return { ...model, revision: 'new' };
    });
    const ref = { id: crypto.randomUUID(), revision: 1 };
    let modelPosts = 0;
    let acceptedModel: Record<string, unknown> | undefined;
    let acceptedImage: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/generate-classroom/model-snapshots') {
          modelPosts += 1;
          if (modelPosts === 1) {
            return Response.json({ errorCode: 'PRO_MODEL_CONNECTION_STALE' }, { status: 409 });
          }
          acceptedModel = JSON.parse(String(init?.body));
          return Response.json({ ref });
        }
        if (url === '/api/agent/media-config-snapshots') {
          acceptedImage = JSON.parse(String(init?.body)).snapshot.image;
          return Response.json({ ref: { id: crypto.randomUUID(), revision: 1 } });
        }
        return Response.json({ jobs: [] });
      }),
    );

    const input = await buildGenerationJobInput(
      session,
      'zh-CN',
      new AbortController().signal,
      vi.fn(),
    );

    // The job names the same platform model the accepted snapshot selection pinned.
    expect(acceptedModel).toEqual({
      selection: { source: 'platform', defaultId: 'zhiyu-default-text', revision: 'new' },
    });
    expect(input.model).toEqual({
      source: 'platform',
      defaultId: 'zhiyu-default-text',
      revision: 'new',
    });
    expect(input.modelConfigRef).toEqual(ref);
    expect(input.media?.image).toEqual(acceptedImage);
    expect(input.media?.image).toMatchObject({ revision: 'new-image' });
    expect(GenerationInputSchema.safeParse(input).success).toBe(true);
    expect(model.revision).toBe('old');
  });
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
  it('drops the remaining images once the account asset quota is full, not the course', async () => {
    let uploads = 0;
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/assets')) {
        uploads += 1;
        if (uploads >= 2) {
          return Response.json(
            { success: false, errorCode: 'ASSET_QUOTA_EXCEEDED', error: 'ASSET_QUOTA_EXCEEDED' },
            { status: 413 },
          );
        }
        return Response.json({
          success: true,
          assetId: 'img-1',
          revision: 1,
          digest: 'b'.repeat(64),
        });
      }
      if (url === '/api/agent/media-config-snapshots') {
        return Response.json({ id: 'ignored', ref: { id: crypto.randomUUID(), revision: 1 } });
      }
      return Response.json({ jobs: [] });
    });
    vi.stubGlobal('fetch', fetchMock);
    mocks.loadBlob.mockResolvedValue(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }));
    const image = (id: string) => ({ id, src: '', pageNumber: 1, storageId: `session_x_${id}` });
    const input = await buildGenerationJobInput(
      {
        ...session,
        pdfText: 'Parabolas',
        pdfImages: [image('img_1'), image('img_2'), image('img_3')],
      },
      'zh-CN',
      new AbortController().signal,
      vi.fn(),
    );
    expect(GenerationInputSchema.safeParse(input).success).toBe(true);
    expect(input.materials?.images?.map((item) => item.id)).toEqual(['img_1']);
    // After the first refusal no further image is attempted.
    expect(uploads).toBe(2);

    uploads = 1;
    mocks.loadAsset.mockResolvedValue(new Blob(['lesson'], { type: 'text/plain' }));
    await expect(
      buildGenerationJobInput(
        {
          ...session,
          documentSources: [
            {
              id: 'source',
              name: 'lesson.txt',
              size: 6,
              order: 0,
              storageKey: 'local',
              assetId: 'a',
            },
          ],
        },
        'zh-CN',
        new AbortController().signal,
        vi.fn(),
      ),
    ).rejects.toMatchObject({ status: 413, code: 'ASSET_QUOTA_EXCEEDED' });
  });
  it('binds client model credentials through an opaque worker snapshot reference', async () => {
    const ref = { id: '123e4567-e89b-42d3-a456-426614174099', revision: 1 };
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/generate-classroom') return Response.json({ jobs: [] });
      if (url === '/api/generate-classroom/model-snapshots') {
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          selection: {
            providerId: 'openai',
            modelId: 'gpt-4.1',
            connection: { auth: 'api-key', apiKey: 'test-client-credential' },
          },
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
  it('freezes a signed-in account through a worker snapshot reference', async () => {
    const ref = { id: '123e4567-e89b-42d3-a456-426614174098', revision: 1 };
    const credentialId = '33333333-3333-4333-8333-333333333333';
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/generate-classroom') return Response.json({ jobs: [] });
      if (url === '/api/generate-classroom/model-snapshots') {
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          selection: {
            providerId: 'openrouter',
            modelId: 'qwen/qwen3.8-27b:free',
            connection: { auth: 'credential', credentialId },
          },
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
      source: 'user',
      modelString: 'openrouter:qwen/qwen3.8-27b:free',
      apiKey: '',
      baseUrl: '',
      credentialId,
    });
    const input = await buildGenerationJobInput(
      session,
      'zh-CN',
      new AbortController().signal,
      vi.fn(),
    );
    expect(input.modelConfigRef).toEqual(ref);
    expect(fetchMock.mock.calls.map((call) => call[0])).toContain(
      '/api/generate-classroom/model-snapshots',
    );
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
