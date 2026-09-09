import { describe, expect, it } from 'vitest';
import {
  MediaProviderConfigError,
  normalizeMediaProviderBaseUrl,
  parseCustomASRProviderConfig,
  parseCustomImageProviderConfig,
  parseCustomTTSProviderConfig,
  parseCustomVideoProviderConfig,
} from '@/lib/server/media-provider-config';

describe('custom media provider configuration', () => {
  it('preserves a gateway path while trimming only the trailing slash', () => {
    expect(normalizeMediaProviderBaseUrl('https://gateway.example.com/team/api/v1/')).toBe(
      'https://gateway.example.com/team/api/v1',
    );
  });

  it.each([
    'https://key:secret@example.com/v1',
    'https://example.com/v1?api_key=secret',
    'https://example.com/v1#secret',
    'file:///tmp/provider',
  ])('rejects unsafe API roots: %s', (value) => {
    expect(() => normalizeMediaProviderBaseUrl(value)).toThrow(MediaProviderConfigError);
  });

  it('parses an explicitly selected keyless custom image protocol', () => {
    expect(
      parseCustomImageProviderConfig(
        'custom-image-local',
        {
          id: 'custom-image-local',
          protocol: 'openai-images',
          baseUrl: 'http://localhost:8080/v1',
          requiresApiKey: false,
        },
        'local/image-model',
      ),
    ).toMatchObject({
      providerId: 'custom-image-local',
      protocol: 'openai-images',
      model: 'local/image-model',
      requiresApiKey: false,
    });
  });

  it('does not accept a provider config belonging to another instance', () => {
    expect(() =>
      parseCustomVideoProviderConfig('custom-video-one', {
        id: 'custom-video-two',
        protocol: 'openrouter-video',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'vendor/video',
        apiKey: 'secret',
      }),
    ).toThrowError('PROVIDER_CONFIG_ID_MISMATCH');
  });

  it('requires a model, enabled state, and key when declared', () => {
    expect(() =>
      parseCustomImageProviderConfig('custom-image-one', {
        protocol: 'siliconflow-images',
        baseUrl: 'https://api.siliconflow.cn/v1',
      }),
    ).toThrowError('MISSING_API_KEY');
    expect(() =>
      parseCustomImageProviderConfig('custom-image-one', {
        protocol: 'siliconflow-images',
        baseUrl: 'https://api.siliconflow.cn/v1',
        apiKey: 'secret',
        enabled: false,
        modelId: 'image/model',
      }),
    ).toThrowError('PROVIDER_DISABLED');
  });

  it('parses only the supported OpenAI-compatible audio protocols', () => {
    expect(
      parseCustomTTSProviderConfig('custom-tts-one', {
        protocol: 'openai-speech',
        baseUrl: 'https://speech.example.com/v1',
        apiKey: 'secret',
        modelId: 'speech/model',
        voice: 'voice/a',
        format: 'mp3',
      }),
    ).toMatchObject({ modelId: 'speech/model', voice: 'voice/a', format: 'mp3' });
    expect(
      parseCustomASRProviderConfig('custom-asr-one', {
        protocol: 'openai-transcription',
        baseUrl: 'https://speech.example.com/v1',
        apiKey: 'secret',
        modelId: 'asr/model',
      }),
    ).toMatchObject({ modelId: 'asr/model' });
  });
});
