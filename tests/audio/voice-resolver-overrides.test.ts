/**
 * Per-agent voice overrides (persisted in settings) take precedence over the
 * agent's registry voiceConfig and the deterministic fallback, with the same
 * enablement validation as voiceConfig.
 */
import { describe, it, expect } from 'vitest';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import {
  resolveAgentVoice,
  resolveNarratorVoiceBinding,
  type ProviderWithVoices,
} from '@/lib/audio/voice-resolver';
import { QWEN_TTS_VOICE_CLONE_MODEL } from '@/lib/audio/constants';
import { platformTTSRequestFields } from '@/lib/audio/platform-tts-selection';

const agent = (id: string, voiceConfig?: AgentConfig['voiceConfig']) =>
  ({ id, voiceConfig }) as AgentConfig;

const qwen: ProviderWithVoices = {
  providerId: 'qwen-tts',
  providerName: 'Qwen TTS',
  voices: [
    { id: 'Cherry', name: 'Cherry' },
    { id: 'Dylan', name: 'Dylan' },
  ],
  modelGroups: [],
};

describe('resolveAgentVoice with overrides', () => {
  const platformQwen: ProviderWithVoices = {
    ...qwen,
    source: 'platform',
    defaultId: 'platform-tts',
    revision: 'r1',
    modelId: 'qwen3-tts-flash',
  };

  it('keeps the configured platform source on an automatically assigned assistant voice', () => {
    const resolved = resolveAgentVoice(agent('assistant'), 1, [platformQwen]);
    expect(resolved).toEqual({
      providerId: 'qwen-tts',
      voiceId: 'Dylan',
      modelId: 'qwen3-tts-flash',
      source: 'platform',
      defaultId: 'platform-tts',
      revision: 'r1',
    });
    expect(
      platformTTSRequestFields(undefined, 'qwen-tts', 'qwen-tts', undefined, undefined, resolved!),
    ).toEqual({ modelSource: 'platform', platformDefaultId: 'platform-tts' });
  });

  it.each([undefined, 'user', 'legacy-managed'] as const)(
    'does not transfer an explicit %s voice binding to the platform credential',
    (source) => {
      const resolved = resolveAgentVoice(
        agent('assistant', {
          providerId: 'qwen-tts',
          voiceId: 'Cherry',
          ...(source ? { source } : {}),
        }),
        0,
        [platformQwen],
      );
      expect(resolved?.source).toBe(source);
      expect(resolved?.defaultId).toBeUndefined();
      expect(
        platformTTSRequestFields(
          undefined,
          'qwen-tts',
          'qwen-tts',
          undefined,
          undefined,
          resolved!,
        ),
      ).toEqual({ modelSource: source ?? 'user' });
    },
  );

  it('prefers the override over voiceConfig and fallback', () => {
    const resolved = resolveAgentVoice(
      agent('default-2', { providerId: 'qwen-tts', voiceId: 'Cherry' }),
      0,
      [qwen],
      { 'default-2': { providerId: 'qwen-tts', voiceId: 'Dylan' } },
    );
    expect(resolved).toEqual({
      providerId: 'qwen-tts',
      modelId: 'qwen3-tts-flash',
      voiceId: 'Dylan',
    });
  });

  it('ignores an override whose provider is not enabled, falling back to voiceConfig', () => {
    const resolved = resolveAgentVoice(
      agent('default-2', { providerId: 'qwen-tts', voiceId: 'Cherry' }),
      0,
      [qwen],
      { 'default-2': { providerId: 'openai-tts', voiceId: 'alloy' } },
    );
    expect(resolved).toEqual({
      providerId: 'qwen-tts',
      modelId: 'qwen3-tts-flash',
      voiceId: 'Cherry',
    });
  });

  it('accepts a non-catalog Qwen voice as a portable clone binding', () => {
    const resolved = resolveAgentVoice(agent('default-2'), 1, [qwen], {
      'default-2': { providerId: 'qwen-tts', voiceId: 'NotAVoice' },
    });
    expect(resolved).toEqual({
      providerId: 'qwen-tts',
      modelId: QWEN_TTS_VOICE_CLONE_MODEL,
      voiceId: 'NotAVoice',
    });
  });

  it('only applies the override of the matching agent id', () => {
    const resolved = resolveAgentVoice(agent('default-3'), 0, [qwen], {
      'default-2': { providerId: 'qwen-tts', voiceId: 'Dylan' },
    });
    expect(resolved).toEqual({ providerId: 'qwen-tts', voiceId: 'Cherry' });
  });

  it('honors a browser-native override only when browser-native is selectable', () => {
    const browserNative: ProviderWithVoices = {
      providerId: 'browser-native-tts',
      providerName: 'Browser',
      voices: [{ id: 'Anna', name: 'Anna' }],
      modelGroups: [],
    };
    const override = {
      'default-2': { providerId: 'browser-native-tts' as const, voiceId: 'Anna' },
    };
    expect(resolveAgentVoice(agent('default-2'), 0, [qwen], override)).toEqual({
      providerId: 'qwen-tts',
      voiceId: 'Cherry',
    });
    expect(resolveAgentVoice(agent('default-2'), 0, [qwen, browserNative], override)).toEqual({
      providerId: 'browser-native-tts',
      modelId: undefined,
      voiceId: 'Anna',
    });
  });

  it('never round-robins a model-bound clone voice into an unbound fallback', () => {
    const withClone: ProviderWithVoices = {
      ...qwen,
      voices: [...qwen.voices, { id: 'clone-1', name: 'Clone' }],
      modelGroups: [
        { modelId: 'qwen3-tts-flash', modelName: 'Flash', voices: qwen.voices },
        {
          modelId: QWEN_TTS_VOICE_CLONE_MODEL,
          modelName: 'VC',
          voices: [{ id: 'clone-1', name: 'Clone' }],
        },
      ],
    };
    expect(resolveAgentVoice(agent('unbound'), 2, [withClone])).toEqual({
      providerId: 'qwen-tts',
      voiceId: 'Cherry',
    });
    expect(
      resolveAgentVoice(agent('legacy-clone', { providerId: 'qwen-tts', voiceId: 'clone-1' }), 0, [
        withClone,
      ]),
    ).toEqual({
      providerId: 'qwen-tts',
      modelId: QWEN_TTS_VOICE_CLONE_MODEL,
      voiceId: 'clone-1',
    });
    expect(
      resolveAgentVoice(
        agent('bound-clone', {
          providerId: 'qwen-tts',
          modelId: QWEN_TTS_VOICE_CLONE_MODEL,
          voiceId: 'clone-1',
        }),
        0,
        [withClone],
      ),
    ).toEqual({
      providerId: 'qwen-tts',
      modelId: QWEN_TTS_VOICE_CLONE_MODEL,
      voiceId: 'clone-1',
    });
  });

  it('accepts a clone binding without a local profile or model and normalizes its model', () => {
    expect(
      resolveAgentVoice(
        agent('remote-clone', { providerId: 'qwen-tts', voiceId: 'remote-vendor-id' }),
        0,
        [qwen],
      ),
    ).toEqual({
      providerId: 'qwen-tts',
      modelId: QWEN_TTS_VOICE_CLONE_MODEL,
      voiceId: 'remote-vendor-id',
    });
  });

  it('uses a bound model when usable and falls back globally when its provider is unusable', () => {
    const global = { providerId: 'qwen-tts' as const, modelId: 'flash', voiceId: 'Cherry' };
    const bound = {
      providerId: 'qwen-tts' as const,
      modelId: QWEN_TTS_VOICE_CLONE_MODEL,
      voiceId: 'clone-1',
    };
    expect(
      resolveNarratorVoiceBinding(bound, global, {
        'qwen-tts': { apiKey: 'key', enabled: true },
      }),
    ).toEqual(bound);
    expect(
      resolveNarratorVoiceBinding(
        { providerId: 'openai-tts', modelId: 'tts-1', voiceId: 'alloy' },
        global,
        {
          'openai-tts': { enabled: false },
          'qwen-tts': { apiKey: 'key', enabled: true },
        },
      ),
    ).toEqual(global);
  });

  it('keeps a known legacy voice while dropping an unknown stale model id', () => {
    const openai: ProviderWithVoices = {
      providerId: 'openai-tts',
      providerName: 'OpenAI',
      voices: [{ id: 'alloy', name: 'Alloy' }],
      modelGroups: [
        { modelId: 'tts-current', modelName: 'Current', voices: [{ id: 'alloy', name: 'Alloy' }] },
      ],
    };
    expect(
      resolveAgentVoice(
        agent('legacy', { providerId: 'openai-tts', modelId: 'tts-retired', voiceId: 'alloy' }),
        0,
        [openai],
      ),
    ).toEqual({ providerId: 'openai-tts', voiceId: 'alloy' });
  });

  it('rejects a stale legacy model when voice metadata excludes the default group', () => {
    const openai: ProviderWithVoices = {
      providerId: 'openai-tts',
      providerName: 'OpenAI',
      voices: [
        { id: 'marin', name: 'Marin' },
        { id: 'alloy', name: 'Alloy' },
      ],
      modelGroups: [
        {
          modelId: 'gpt-4o-mini-tts',
          modelName: 'Default',
          voices: [{ id: 'alloy', name: 'Alloy' }],
        },
      ],
    };
    expect(
      resolveAgentVoice(
        agent('legacy', { providerId: 'openai-tts', modelId: 'tts-retired', voiceId: 'marin' }),
        1,
        [openai],
      ),
    ).toEqual({ providerId: 'openai-tts', voiceId: 'alloy' });
  });

  it('falls back globally for an empty narrator voice id on every provider', () => {
    const global = { providerId: 'qwen-tts' as const, voiceId: 'Cherry' };
    expect(
      resolveNarratorVoiceBinding({ providerId: 'openai-tts', voiceId: '   ' }, global, {
        'openai-tts': { apiKey: 'key', enabled: true },
        'qwen-tts': { apiKey: 'key', enabled: true },
      }),
    ).toEqual({ providerId: 'qwen-tts', modelId: 'qwen3-tts-flash', voiceId: 'Cherry' });
  });
});
