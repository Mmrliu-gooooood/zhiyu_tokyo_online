import { describe, expect, it } from 'vitest';
import {
  bindGeneratedPlatformTTSVoices,
  platformTTSRequestFields,
  roleVoiceBinding,
  scopeProvidersToPlatformTTS,
} from '@/lib/audio/platform-tts-selection';
import { getEnabledProvidersWithVoices, resolveAgentVoice } from '@/lib/audio/voice-resolver';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { PlatformDefaultCatalog } from '@/lib/types/platform-default-models';
import type { GeneratedAgentConfig } from '@/lib/types/stage';

describe('platform TTS request source', () => {
  const globalPlatform = { source: 'platform', defaultId: 'zhiyu-default-tts' } as const;
  const catalog: PlatformDefaultCatalog = {
    version: 2,
    entries: [{
      defaultId: 'zhiyu-default-tts', capability: 'tts', providerId: 'minimax-tts',
      providerName: 'MiniMax', modelId: 'speech-2.8-turbo', displayName: 'Platform TTS',
      available: true, status: 'available', revision: 'rev-1', parameters: {},
    }],
  };
  const agent: GeneratedAgentConfig = {
    id: 'teacher', name: 'Teacher', role: 'teacher', persona: 'Patient',
    avatar: '/teacher.png', color: '#000000', priority: 1,
    voiceConfig: { providerId: 'minimax-tts', voiceId: 'female-yujie' },
  };

  it('stamps only a newly advertised platform voice with its verified default', () => {
    const advertised = [{ providerId: 'minimax-tts', voiceId: 'female-yujie' }];
    const [bound] = bindGeneratedPlatformTTSVoices([agent], advertised, globalPlatform, catalog);
    expect(bound.voiceConfig).toMatchObject({
      source: 'platform', defaultId: 'zhiyu-default-tts', revision: 'rev-1',
    });
    expect(platformTTSRequestFields(
      globalPlatform, 'minimax-tts', 'minimax-tts', 'speech-2.8-hd',
      'speech-2.8-turbo', bound.voiceConfig,
    )).toEqual({ modelSource: 'platform', platformDefaultId: 'zhiyu-default-tts' });
    expect(bindGeneratedPlatformTTSVoices([agent], [], globalPlatform, catalog)[0].voiceConfig)
      .toEqual(agent.voiceConfig);
  });

  it('preserves explicit user voice ownership and rejects a different model', () => {
    const advertised = [{ providerId: 'minimax-tts', voiceId: 'female-yujie' }];
    expect(bindGeneratedPlatformTTSVoices([
      { ...agent, voiceConfig: { ...agent.voiceConfig!, source: 'user' } },
    ], advertised, globalPlatform, catalog)[0].voiceConfig?.source).toBe('user');
    expect(bindGeneratedPlatformTTSVoices([
      { ...agent, voiceConfig: { ...agent.voiceConfig!, modelId: 'speech-2.8-hd' } },
    ], advertised, globalPlatform, catalog)[0].voiceConfig?.source).toBeUndefined();
  });

  it('uses the global platform default when no role binding overrides it', () => {
    expect(
      platformTTSRequestFields(
        globalPlatform,
        'minimax-tts',
        'minimax-tts',
        'speech-2.8-turbo',
        'speech-2.8-turbo',
      ),
    ).toEqual({ modelSource: 'platform', platformDefaultId: 'zhiyu-default-tts' });
  });

  it('treats a pre-source role binding as user-owned instead of inferring platform ownership', () => {
    expect(
      platformTTSRequestFields(
        globalPlatform,
        'minimax-tts',
        'minimax-tts',
        'speech-2.8-turbo',
        'speech-2.8-turbo',
        { defaultId: undefined },
      ),
    ).toEqual({ modelSource: 'user' });
  });

  it('uses an explicit role binding source ahead of the global selection', () => {
    expect(
      platformTTSRequestFields(
        globalPlatform,
        'minimax-tts',
        'minimax-tts',
        'speech-2.8-turbo',
        'speech-2.8-turbo',
        { source: 'user' },
      ),
    ).toEqual({ modelSource: 'user' });
    expect(
      platformTTSRequestFields(
        { source: 'user', providerId: 'qwen-tts' },
        'minimax-tts',
        'qwen-tts',
        'speech-2.8-turbo',
        undefined,
        { source: 'platform', defaultId: 'zhiyu-default-tts' },
      ),
    ).toEqual({ modelSource: 'platform', platformDefaultId: 'zhiyu-default-tts' });
  });
});

describe('voice choices under a platform TTS default', () => {
  const selection = { source: 'platform', defaultId: 'zhiyu-default-tts' } as const;
  const catalog: PlatformDefaultCatalog = {
    version: 2,
    entries: [{
      defaultId: 'zhiyu-default-tts', capability: 'tts', providerId: 'minimax-tts',
      providerName: 'MiniMax', modelId: 'speech-2.8-turbo', displayName: 'Platform TTS',
      available: true, status: 'available', revision: 'rev-1', parameters: {},
    }],
  };
  // The user has no MiniMax key of their own; only the platform makes it usable.
  const ownConfig = { 'openai-tts': { enabled: true, apiKey: 'sk-test' } };
  const ownKeyConfig = { ...ownConfig, 'minimax-tts': { apiKey: 'own-key' } };
  const providers = () =>
    getEnabledProvidersWithVoices({
      ...ownConfig,
      'minimax-tts': { enabled: true, isServerConfigured: true },
    });

  it('offers only the platform model of the platform provider, stamped as platform', () => {
    const scoped = scopeProvidersToPlatformTTS(providers(), selection, catalog, ownConfig);
    const minimax = scoped.find((provider) => provider.providerId === 'minimax-tts');
    expect(minimax?.modelGroups.map((group) => group.modelId)).toEqual(['speech-2.8-turbo']);
    expect(minimax).toMatchObject({
      source: 'platform', defaultId: 'zhiyu-default-tts', revision: 'rev-1',
      modelId: 'speech-2.8-turbo', platformOnly: true,
    });
    expect(minimax?.voices).toEqual(minimax?.modelGroups[0].voices);
    // The user's own providers are untouched.
    expect(scoped.find((provider) => provider.providerId === 'openai-tts')).toEqual(
      providers().find((provider) => provider.providerId === 'openai-tts'),
    );
    expect(scopeProvidersToPlatformTTS(
      providers(), { source: 'user', providerId: 'minimax-tts' }, catalog, ownConfig,
    )).toEqual(providers());
    expect(
      scopeProvidersToPlatformTTS(providers(), selection, catalog, ownKeyConfig)
        .find((provider) => provider.providerId === 'minimax-tts')?.platformOnly,
    ).toBeUndefined();
  });

  it('skips a user-owned pick on the platform provider and keeps a platform pick', () => {
    const scoped = scopeProvidersToPlatformTTS(providers(), selection, catalog, ownConfig).filter(
      (provider) => provider.providerId === 'minimax-tts',
    );
    const agent = { id: 'default-2', role: 'assistant' } as AgentConfig;
    const userPick = {
      source: 'user' as const, providerId: 'minimax-tts' as const, modelId: 'speech-2.8-hd',
      voiceId: 'female-yujie',
    };
    const platformPick = {
      source: 'platform' as const, defaultId: 'zhiyu-default-tts', revision: 'rev-1',
      providerId: 'minimax-tts' as const, modelId: 'speech-2.8-turbo', voiceId: 'female-yujie',
    };
    expect(resolveAgentVoice(agent, 1, scoped, { 'default-2': userPick })).toMatchObject({
      source: 'platform', defaultId: 'zhiyu-default-tts',
    });
    expect(resolveAgentVoice(agent, 1, scoped, { 'default-2': platformPick })).toEqual(platformPick);

    // With the user's own MiniMax key, their pick keeps its credential owner.
    const withOwnKey = scopeProvidersToPlatformTTS(providers(), selection, catalog, ownKeyConfig);
    expect(resolveAgentVoice(agent, 1, withOwnKey, { 'default-2': userPick })).toMatchObject({
      source: 'user', voiceId: 'female-yujie',
    });

    expect(roleVoiceBinding([userPick, platformPick], selection, catalog, ownConfig))
      .toBe(platformPick);
    expect(roleVoiceBinding([userPick], selection, catalog, ownConfig)).toBeUndefined();
    expect(roleVoiceBinding([userPick], selection, catalog, ownKeyConfig)).toBe(userPick);
    const ownProvider = { source: 'user' as const, providerId: 'openai-tts', voiceId: 'alloy' };
    expect(roleVoiceBinding([ownProvider], selection, catalog, ownConfig)).toBe(ownProvider);
    expect(roleVoiceBinding(
      [userPick], { source: 'user', providerId: 'minimax-tts' }, catalog, ownConfig,
    )).toBe(userPick);
  });
});
