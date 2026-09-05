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
  it('transfers source bytes into the signed owner scope before submitting generation', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async (url: string) =>
        url.endsWith('/assets')
          ? Response.json({
              success: true,
              assetId: 'owned-source',
              revision: 1,
              digest: 'a'.repeat(64),
            })
          : Response.json({ jobs: [] }),
      );
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
  it('rejects client credentials without putting them in any request or queue input', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    mocks.model.mockReturnValue({
      modelString: 'openai:gpt-4.1',
      apiKey: 'test-client-credential',
      baseUrl: '',
    });
    await expect(
      buildGenerationJobInput(session, 'zh-CN', new AbortController().signal, vi.fn()),
    ).rejects.toThrow('BACKGROUND_CLIENT_PROVIDER_UNSUPPORTED');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('reuses already-uploaded owner assets after a lost create response', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({ jobs: [] }));
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
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.loadBlob).not.toHaveBeenCalled();
    expect(mocks.loadAsset).not.toHaveBeenCalled();
  });
});
