import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  providers: vi.fn(() => ({})),
  apiKey: vi.fn((_providerId: string, snapshotKey?: string) => snapshotKey || ''),
}));

vi.mock('@/lib/server/provider-config', () => ({
  getServerTTSProviders: mocks.providers,
  resolveTTSApiKey: mocks.apiKey,
}));

import {
  mediaConfigVoiceSource,
  resolveEffectiveSessionVoice,
  sessionVoiceCatalog,
} from '@/lib/server/agent-runtime/effective-voice-directory';
import type { MediaConfigSnapshotContent } from '@/lib/server/media-config-snapshots';

const execution = {
  providerId: 'minimax-tts',
  apiKey: 'session-secret',
  baseUrl: '',
  requiresApiKey: true,
  enabled: true,
  modelId: 'speech-2.8-hd',
  speed: 1,
};

describe('effective session voice directory', () => {
  it('keeps v1 exact while v2 resolves every authorized voice through one execution config', () => {
    const v1 = {
      version: 1,
      ttsEnabled: true,
      tts: [{ ...execution, voice: 'female-yujie', default: true }],
    } satisfies MediaConfigSnapshotContent;
    const v2 = {
      version: 2,
      ttsEnabled: true,
      ttsProviders: [execution],
      ttsDefault: {
        providerId: 'minimax-tts',
        modelId: 'speech-2.8-hd',
        voiceId: 'female-yujie',
        speed: 1,
      },
      ttsVoiceDirectory: [
        {
          providerId: 'minimax-tts',
          modelId: 'speech-2.8-hd',
          voiceIds: ['female-yujie', 'male-qn-jingying'],
        },
      ],
    } satisfies MediaConfigSnapshotContent;

    expect(sessionVoiceCatalog(mediaConfigVoiceSource(v1)).map((voice) => voice.binding)).toEqual([
      'minimax-tts::female-yujie',
    ]);
    expect(sessionVoiceCatalog(mediaConfigVoiceSource(v2)).map((voice) => voice.binding)).toEqual([
      'minimax-tts::female-yujie',
      'minimax-tts::male-qn-jingying',
    ]);
    expect(
      resolveEffectiveSessionVoice(mediaConfigVoiceSource(v2), {
        providerId: 'minimax-tts',
        modelId: 'speech-2.8-hd',
        voiceId: 'male-qn-jingying',
      }),
    ).toMatchObject({
      providerId: 'minimax-tts',
      modelId: 'speech-2.8-hd',
      voice: 'male-qn-jingying',
      apiKey: 'session-secret',
    });
  });
});
