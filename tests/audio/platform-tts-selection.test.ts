import { describe, expect, it } from 'vitest';
import { platformTTSRequestFields } from '@/lib/audio/platform-tts-selection';

describe('platform TTS request source', () => {
  const globalPlatform = { source: 'platform', defaultId: 'zhiyu-default-tts' } as const;

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
