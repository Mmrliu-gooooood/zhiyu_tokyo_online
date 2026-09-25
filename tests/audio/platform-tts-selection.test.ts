import { describe, expect, it } from 'vitest';
import {
  bindGeneratedPlatformTTSVoices,
  platformTTSRequestFields,
} from '@/lib/audio/platform-tts-selection';
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
