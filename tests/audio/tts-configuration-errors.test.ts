import { describe, expect, it } from 'vitest';

import { generateTTS, TTSConfigurationError } from '@/lib/audio/tts-providers';
import type { TTSModelConfig } from '@/lib/audio/types';

const cases: Array<{ name: string; config: TTSModelConfig }> = [
  {
    name: 'missing required API key',
    config: { providerId: 'openai-tts', voice: 'alloy' },
  },
  {
    name: 'server-side browser native provider',
    config: { providerId: 'browser-native-tts', voice: 'default' },
  },
  {
    name: 'unsupported provider id',
    config: { providerId: 'unsupported' as never, voice: 'default' },
  },
  {
    name: 'VoxCPM auto voice without agent context',
    config: {
      providerId: 'voxcpm-tts',
      baseUrl: 'https://tts.test/v1',
      voice: 'voxcpm:auto',
    },
  },
  {
    name: 'malformed Doubao credential pair',
    config: { providerId: 'doubao-tts', apiKey: 'app-id:', voice: 'voice' },
  },
];

describe('TTS request-before-send validation', () => {
  it.each(cases)('types $name as a configuration failure', async ({ config }) => {
    const error = await generateTTS(config, 'text').catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(TTSConfigurationError);
    expect(error).toMatchObject({
      code: 'TTS_CONFIGURATION_INVALID',
      safeSummary: 'TTS request was not sent because its configuration is invalid.',
    });
  });
});
