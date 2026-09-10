import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  generateTTS,
  TTSProviderTransientError,
  TTSProviderTerminalError,
} from '@/lib/audio/tts-providers';
import type { TTSModelConfig } from '@/lib/audio/types';

const providers: TTSModelConfig[] = [
  { providerId: 'openai-tts', apiKey: 'key', baseUrl: 'https://tts.test', voice: 'alloy' },
  { providerId: 'azure-tts', apiKey: 'key', baseUrl: 'https://tts.test', voice: 'zh-CN' },
  { providerId: 'glm-tts', apiKey: 'key', baseUrl: 'https://tts.test', voice: 'female' },
  { providerId: 'qwen-tts', apiKey: 'key', baseUrl: 'https://tts.test', voice: 'Cherry' },
  { providerId: 'voxcpm-tts', baseUrl: 'https://tts.test/v1', voice: 'default' },
  { providerId: 'minimax-tts', apiKey: 'key', baseUrl: 'https://tts.test', voice: 'female' },
  {
    providerId: 'elevenlabs-tts',
    apiKey: 'key',
    baseUrl: 'https://tts.test',
    voice: 'voice-id',
  },
  { providerId: 'lemonade-tts', baseUrl: 'https://tts.test/v1', voice: 'af_heart' },
  { providerId: 'doubao-tts', apiKey: 'ark-key', baseUrl: 'https://tts.test', voice: 'voice' },
];

describe('TTS explicit terminal responses', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(providers)('types an explicit $providerId HTTP failure as terminal', async (config) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'provider rejected request' } }), {
        status: 400,
        statusText: 'Bad Request',
        headers: { 'content-type': 'application/json' },
      }),
    );

    const error = await generateTTS(config, 'private narration').catch(
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(TTSProviderTerminalError);
    expect(error).toMatchObject({
      code: config.providerId === 'qwen-tts' ? 'QWEN_TTS_ERROR' : 'TTS_PROVIDER_TERMINAL_FAILURE',
      safeSummary: 'TTS provider returned an explicit terminal failure.',
      httpStatus: 400,
    });
  });

  it.each(providers)('types an explicit $providerId HTTP 503 as transient', async (config) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'temporarily unavailable' } }), {
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'content-type': 'application/json' },
      }),
    );

    const error = await generateTTS(config, 'private narration').catch(
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(TTSProviderTransientError);
    expect(error).toMatchObject({
      code: 'TTS_PROVIDER_TRANSIENT_FAILURE',
      safeSummary: 'TTS provider returned an explicit transient failure.',
      httpStatus: 503,
    });
  });

  it.each([
    {
      config: providers.find((item) => item.providerId === 'minimax-tts')!,
      body: JSON.stringify({ base_resp: { status_code: 1002, status_msg: 'rejected' } }),
    },
    {
      config: providers.find((item) => item.providerId === 'doubao-tts')!,
      body: JSON.stringify({ code: 40000000, message: 'rejected' }),
    },
  ])(
    'types a successful HTTP response containing a $config.providerId failure',
    async ({ config, body }) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
      );

      await expect(generateTTS(config, 'private narration')).rejects.toBeInstanceOf(
        TTSProviderTerminalError,
      );
    },
  );
});
