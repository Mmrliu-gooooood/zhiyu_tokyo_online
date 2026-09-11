import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  providers: vi.fn(),
  generate: vi.fn(),
  persist: vi.fn(),
  resolveApiKey: vi.fn((_id: string, value?: string) => value || ''),
  resolveBaseUrl: vi.fn((_id: string, value?: string) => value),
  resolveModel: vi.fn((_id: string, value?: string) => value || ''),
}));

vi.mock('@/lib/server/provider-config', () => ({
  getServerTTSProviders: mocks.providers,
  resolveTTSApiKey: mocks.resolveApiKey,
  resolveTTSBaseUrl: mocks.resolveBaseUrl,
  resolveTTSModel: mocks.resolveModel,
}));

vi.mock('@/lib/audio/tts-providers', () => ({ generateTTS: mocks.generate }));

vi.mock('@/lib/server/classroom-media-bytes', () => ({
  persistClassroomMediaBytes: mocks.persist,
}));

import { synthesizeSceneNarration } from '@/lib/server/agent-runtime/scene-tts';
import type { Scene } from '@/lib/types/stage';

const scene = {
  id: 'scene-a',
  stageId: 'stage-a',
  order: 1,
  title: 'A',
  type: 'slide',
  content: { type: 'slide' },
  actions: [{ id: 'speech-a', type: 'speech', text: 'Hello' }],
} as Scene;

describe('scene TTS capability routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveApiKey.mockImplementation((_id: string, value?: string) => value || '');
    mocks.resolveBaseUrl.mockImplementation((_id: string, value?: string) => value);
    mocks.resolveModel.mockImplementation((_id: string, value?: string) => value || '');
  });

  it('honors the server capability force-off before synthesis', async () => {
    mocks.providers.mockReturnValue({ 'configured-tts': { disabled: true } });
    const summary = await synthesizeSceneNarration({
      scene: structuredClone(scene),
      force: false,
    });
    expect(summary).toMatchObject({ available: false, changed: false });
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it('stores generated narration bytes in classroom media', async () => {
    mocks.providers.mockReturnValue({ 'configured-tts': {} });
    mocks.generate.mockResolvedValue({ audio: new Uint8Array([1, 2]), format: 'mp3' });
    mocks.persist.mockResolvedValue('/api/classroom-media/stage-a/media/tts-speech-a-abc123.mp3');
    const target = structuredClone(scene);
    const summary = await synthesizeSceneNarration({ scene: target, force: false });
    expect(summary).toMatchObject({ available: true, changed: true, generated: 1 });
    // The durable reference is the RELATIVE classroom-media path (origin-
    // independent), stamped on both `audioId` and the legacy `audioUrl` pair
    // the browser's narration consumers resolve (timeline status/preview,
    // playback fetch, exports) — so agent-generated narration is voiced and
    // playable on any deployment origin.
    expect(target.actions?.[0]).toMatchObject({
      audioId: '/api/classroom-media/stage-a/media/tts-speech-a-abc123.mp3',
      audioUrl: '/api/classroom-media/stage-a/media/tts-speech-a-abc123.mp3',
    });
    expect(mocks.persist).toHaveBeenCalledWith(
      expect.objectContaining({ stageId: 'stage-a', mime: 'audio/mpeg' }),
    );
  });

  it('does not substitute another snapshot when an explicit narrator binding is missing', async () => {
    mocks.providers.mockReturnValue({});
    const summary = await synthesizeSceneNarration({
      scene: structuredClone(scene),
      force: false,
      roster: [
        {
          id: 'teacher',
          role: 'teacher',
          voiceConfig: { providerId: 'custom-tts-bound', voiceId: 'voice-a' },
        },
      ] as never,
      providerConfigs: [
        {
          providerId: 'custom-tts-other',
          apiKey: 'secret',
          baseUrl: 'https://speech.example/v1',
          requiresApiKey: true,
          enabled: true,
          modelId: 'model-a',
          voice: 'voice-b',
        },
      ],
    });
    expect(summary).toMatchObject({ available: false, changed: false });
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it('matches a teacher override by provider, model and voice', async () => {
    mocks.providers.mockReturnValue({});
    mocks.generate.mockResolvedValue({ audio: new Uint8Array([1, 2]), format: 'mp3' });
    mocks.persist.mockResolvedValue('/api/classroom-media/stage-a/media/voice-two.mp3');
    await synthesizeSceneNarration({
      scene: structuredClone(scene),
      force: false,
      roster: [
        {
          id: 'teacher',
          name: 'Teacher',
          role: 'teacher',
          persona: 'Clear',
          avatar: '',
          color: '#000000',
          priority: 1,
          voiceConfig: {
            providerId: 'minimax-tts',
            modelId: 'speech-2.8-turbo',
            voiceId: 'voice-two',
          },
        },
      ],
      providerConfigs: [
        {
          providerId: 'minimax-tts',
          apiKey: 'key-one',
          baseUrl: '',
          requiresApiKey: true,
          enabled: true,
          modelId: 'speech-2.8-hd',
          voice: 'voice-one',
        },
        {
          providerId: 'minimax-tts',
          apiKey: 'key-two',
          baseUrl: '',
          requiresApiKey: true,
          enabled: true,
          modelId: 'speech-2.8-turbo',
          voice: 'voice-two',
        },
      ],
    });

    expect(mocks.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'minimax-tts',
        apiKey: 'key-two',
        modelId: 'speech-2.8-turbo',
        voice: 'voice-two',
      }),
      'Hello',
    );
  });

  it('uses only the owner credentials and endpoint for a user selection', async () => {
    mocks.providers.mockReturnValue({ 'minimax-tts': {} });
    mocks.generate.mockResolvedValue({ audio: new Uint8Array([1, 2]), format: 'mp3' });
    mocks.persist.mockResolvedValue('/api/classroom-media/stage-a/media/user.mp3');
    mocks.resolveApiKey.mockReturnValue('server-key');
    mocks.resolveBaseUrl.mockReturnValue('https://server.example/v1');
    mocks.resolveModel.mockReturnValue('server-model');

    await synthesizeSceneNarration({
      scene: structuredClone(scene),
      force: false,
      providerConfigs: [
        {
          source: 'user',
          providerId: 'minimax-tts',
          apiKey: 'owner-key',
          baseUrl: 'https://owner.example/v1',
          requiresApiKey: true,
          enabled: true,
          modelId: 'owner-model',
          voice: 'owner-voice',
        },
      ],
    });

    expect(mocks.resolveApiKey).not.toHaveBeenCalled();
    expect(mocks.resolveBaseUrl).not.toHaveBeenCalled();
    expect(mocks.resolveModel).not.toHaveBeenCalled();
    expect(mocks.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'owner-key',
        baseUrl: 'https://owner.example/v1',
        modelId: 'owner-model',
      }),
      'Hello',
    );
  });

  it('uses the explicitly marked session default instead of array order', async () => {
    mocks.providers.mockReturnValue({});
    mocks.generate.mockResolvedValue({ audio: new Uint8Array([1, 2]), format: 'mp3' });
    mocks.persist.mockResolvedValue('/api/classroom-media/stage-a/media/default.mp3');

    await synthesizeSceneNarration({
      scene: structuredClone(scene),
      force: false,
      providerConfigs: [
        {
          providerId: 'minimax-tts',
          apiKey: 'other-key',
          baseUrl: '',
          requiresApiKey: true,
          enabled: true,
          modelId: 'speech-2.8-hd',
          voice: 'male-qn-jingying',
        },
        {
          providerId: 'minimax-tts',
          apiKey: 'default-key',
          baseUrl: '',
          requiresApiKey: true,
          enabled: true,
          modelId: 'speech-2.8-hd',
          voice: 'female-yujie',
          default: true,
        },
      ],
    });

    expect(mocks.generate).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'default-key', voice: 'female-yujie' }),
      'Hello',
    );
  });

  it('treats an explicit empty provider snapshot as disabled instead of using server defaults', async () => {
    mocks.providers.mockReturnValue({ 'configured-tts': {} });
    const summary = await synthesizeSceneNarration({
      scene: structuredClone(scene),
      force: false,
      providerConfigs: [],
    });
    expect(summary).toMatchObject({ available: false, changed: false });
    expect(mocks.generate).not.toHaveBeenCalled();
  });
});
