import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore, type SettingsState } from '@/lib/store/settings';
import {
  buildMediaConfigSnapshot,
  revokeMediaConfigSnapshotsForProvider,
} from '@/lib/workbench/media-config-snapshot-client';

function settings(overrides: Partial<SettingsState>): SettingsState {
  return { ...useSettingsStore.getState(), ...overrides };
}

describe('media config snapshot client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('freezes a versioned MiniMax directory without copying its execution secret per voice', () => {
    const state = useSettingsStore.getState();
    const snapshot = buildMediaConfigSnapshot(
      settings({
        ttsEnabled: true,
        ttsProviderId: 'minimax-tts',
        ttsVoice: 'female-yujie',
        ttsProvidersConfig: {
          ...state.ttsProvidersConfig,
          'minimax-tts': {
            ...state.ttsProvidersConfig['minimax-tts'],
            apiKey: 'session-secret',
            enabled: true,
            modelId: 'speech-2.8-hd',
          },
        },
      }),
    );

    expect(snapshot).toMatchObject({
      version: 2,
      ttsDefault: {
        providerId: 'minimax-tts',
        modelId: 'speech-2.8-hd',
        voiceId: 'female-yujie',
      },
      ttsProviders: [
        expect.objectContaining({
          providerId: 'minimax-tts',
          apiKey: 'session-secret',
          modelId: 'speech-2.8-hd',
        }),
      ],
      ttsVoiceDirectory: [
        expect.objectContaining({
          providerId: 'minimax-tts',
          modelId: 'speech-2.8-hd',
          voiceIds: expect.arrayContaining(['female-yujie', 'male-qn-jingying']),
        }),
      ],
    });
    expect(snapshot?.ttsVoiceDirectory?.[0]?.voiceIds.length).toBeGreaterThan(1);
    expect('tts' in (snapshot ?? {})).toBe(false);
    expect(JSON.stringify(snapshot).match(/session-secret/g)).toHaveLength(1);
  });

  it('captures every built-in server media provider through the encrypted snapshot path', () => {
    const state = useSettingsStore.getState();
    const imageIds = [
      'seedream',
      'openai-image',
      'qwen-image',
      'nano-banana',
      'minimax-image',
      'grok-image',
      'comfyui-image',
      'lemonade',
    ] as const;
    const videoIds = [
      'seedance',
      'kling',
      'veo',
      'minimax-video',
      'grok-video',
      'happyhorse',
    ] as const;
    const ttsIds = [
      'openai-tts',
      'azure-tts',
      'glm-tts',
      'qwen-tts',
      'doubao-tts',
      'elevenlabs-tts',
      'minimax-tts',
      'voxcpm-tts',
      'lemonade-tts',
    ] as const;

    for (const providerId of imageIds) {
      expect(
        buildMediaConfigSnapshot(
          settings({
            imageGenerationEnabled: true,
            imageProviderId: providerId,
            imageProvidersConfig: {
              ...state.imageProvidersConfig,
              [providerId]: {
                ...state.imageProvidersConfig[providerId],
                apiKey: 'placeholder',
                enabled: true,
              },
            },
          }),
        )?.image?.providerId,
      ).toBe(providerId);
    }
    for (const providerId of videoIds) {
      expect(
        buildMediaConfigSnapshot(
          settings({
            videoGenerationEnabled: true,
            videoProviderId: providerId,
            videoProvidersConfig: {
              ...state.videoProvidersConfig,
              [providerId]: {
                ...state.videoProvidersConfig[providerId],
                apiKey: 'placeholder',
                enabled: true,
              },
            },
          }),
        )?.video?.providerId,
      ).toBe(providerId);
    }
    for (const providerId of ttsIds) {
      expect(
        buildMediaConfigSnapshot(
          settings({
            ttsEnabled: true,
            ttsProviderId: providerId,
            ttsProvidersConfig: {
              ...state.ttsProvidersConfig,
              [providerId]: {
                ...state.ttsProvidersConfig[providerId],
                apiKey: 'placeholder',
                enabled: true,
              },
            },
          }),
        )?.ttsProviders?.[0]?.providerId,
      ).toBe(providerId);
    }
  });

  it('freezes explicit disabled intent without requiring a provider configuration', () => {
    expect(
      buildMediaConfigSnapshot(
        settings({
          imageGenerationEnabled: false,
          videoGenerationEnabled: false,
          ttsEnabled: false,
        }),
      ),
    ).toEqual({
      version: 2,
      imageEnabled: false,
      videoEnabled: false,
      ttsEnabled: false,
    });
  });

  it('captures selected built-in media credentials and TTS provider options', () => {
    const state = useSettingsStore.getState();
    const snapshot = buildMediaConfigSnapshot(
      settings({
        imageGenerationEnabled: true,
        imageProviderId: 'minimax-image',
        imageModelId: 'image-01',
        imageProvidersConfig: {
          ...state.imageProvidersConfig,
          'minimax-image': {
            ...state.imageProvidersConfig['minimax-image'],
            apiKey: 'image-secret',
            enabled: true,
          },
        },
        videoGenerationEnabled: true,
        videoProviderId: 'minimax-video',
        videoModelId: 'MiniMax-Hailuo-2.3',
        videoProvidersConfig: {
          ...state.videoProvidersConfig,
          'minimax-video': {
            ...state.videoProvidersConfig['minimax-video'],
            apiKey: 'video-secret',
            enabled: true,
          },
        },
        ttsEnabled: true,
        ttsProviderId: 'minimax-tts',
        ttsVoice: 'male-qn-qingse',
        ttsProvidersConfig: {
          ...state.ttsProvidersConfig,
          'minimax-tts': {
            ...state.ttsProvidersConfig['minimax-tts'],
            apiKey: 'tts-secret',
            enabled: true,
            providerOptions: { emotion: 'happy' },
          },
        },
      }),
    );

    expect(snapshot).toMatchObject({
      version: 2,
      imageEnabled: true,
      videoEnabled: true,
      ttsEnabled: true,
      image: {
        providerId: 'minimax-image',
        apiKey: 'image-secret',
        modelId: 'image-01',
      },
      video: {
        providerId: 'minimax-video',
        apiKey: 'video-secret',
        modelId: 'MiniMax-Hailuo-2.3',
      },
      ttsProviders: [
        expect.objectContaining({
          providerId: 'minimax-tts',
          apiKey: 'tts-secret',
          modelId: 'speech-2.8-hd',
          providerOptions: { emotion: 'happy' },
        }),
      ],
      ttsDefault: {
        providerId: 'minimax-tts',
        modelId: 'speech-2.8-hd',
        voiceId: 'male-qn-qingse',
        speed: expect.any(Number),
      },
    });
  });

  it('preserves an explicit local disable for built-in providers', () => {
    const state = useSettingsStore.getState();
    const snapshot = buildMediaConfigSnapshot(
      settings({
        imageGenerationEnabled: true,
        imageProviderId: 'minimax-image',
        imageProvidersConfig: {
          ...state.imageProvidersConfig,
          'minimax-image': { ...state.imageProvidersConfig['minimax-image'], enabled: false },
        },
        videoGenerationEnabled: true,
        videoProviderId: 'minimax-video',
        videoProvidersConfig: {
          ...state.videoProvidersConfig,
          'minimax-video': { ...state.videoProvidersConfig['minimax-video'], enabled: false },
        },
        ttsEnabled: true,
        ttsProviderId: 'minimax-tts',
        ttsProvidersConfig: {
          ...state.ttsProvidersConfig,
          'minimax-tts': { ...state.ttsProvidersConfig['minimax-tts'], enabled: false },
        },
      }),
    );

    expect(snapshot?.image?.enabled).toBe(false);
    expect(snapshot?.video?.enabled).toBe(false);
    expect(snapshot?.ttsProviders?.[0]?.enabled).toBe(false);
  });

  it('keeps browser-native TTS in the browser and blocks server fallback', () => {
    const snapshot = buildMediaConfigSnapshot(
      settings({
        imageGenerationEnabled: false,
        videoGenerationEnabled: false,
        ttsEnabled: true,
        ttsProviderId: 'browser-native-tts',
      }),
    );

    expect(snapshot).toMatchObject({ ttsEnabled: true });
    expect('tts' in (snapshot ?? {})).toBe(false);
  });

  it('includes provider configuration for a voice bound on the current course roster', () => {
    const state = useSettingsStore.getState();
    const snapshot = buildMediaConfigSnapshot(
      settings({
        ttsEnabled: true,
        ttsProviderId: 'minimax-tts',
        ttsProvidersConfig: {
          ...state.ttsProvidersConfig,
          'minimax-tts': {
            ...state.ttsProvidersConfig['minimax-tts'],
            apiKey: 'minimax-secret',
          },
          'doubao-tts': {
            ...state.ttsProvidersConfig['doubao-tts'],
            apiKey: 'doubao-secret',
            modelId: 'doubao-model',
          },
        },
      }),
      [{ providerId: 'doubao-tts', modelId: 'doubao-model', voiceId: 'doubao-voice' }],
    );

    expect(snapshot?.ttsProviders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerId: 'minimax-tts', apiKey: 'minimax-secret' }),
        expect.objectContaining({
          providerId: 'doubao-tts',
          apiKey: 'doubao-secret',
          modelId: 'doubao-model',
        }),
      ]),
    );
    expect(snapshot?.ttsVoiceDirectory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerId: 'doubao-tts',
          modelId: 'doubao-model',
          voiceIds: expect.arrayContaining(['doubao-voice']),
        }),
      ]),
    );
  });

  it('drains provider revocations that arrive while an earlier delete is pending', async () => {
    const values = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        requests.push(String(init?.body));
        if (requests.length === 1) await firstPending;
        return { ok: true } as Response;
      }),
    );

    const first = revokeMediaConfigSnapshotsForProvider('provider-one');
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const second = revokeMediaConfigSnapshotsForProvider('provider-two');
    releaseFirst();
    await Promise.all([first, second]);

    expect(requests).toEqual([
      JSON.stringify({ providerInstanceId: 'provider-one' }),
      JSON.stringify({ providerInstanceId: 'provider-two' }),
    ]);
    expect(values.size).toBe(0);
  });

  it('revokes directly when browser storage is unavailable', async () => {
    vi.stubGlobal('window', undefined);
    const fetchMock = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    await revokeMediaConfigSnapshotsForProvider('provider-without-storage');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/agent/media-config-snapshots',
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ providerInstanceId: 'provider-without-storage' }),
      }),
    );
  });
});
