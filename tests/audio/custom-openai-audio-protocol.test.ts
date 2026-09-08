import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateTTS } from '@/lib/audio/tts-providers';
import { transcribeAudio } from '@/lib/audio/asr-providers';

describe('custom OpenAI-compatible audio protocols', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends the selected TTS model, voice, format and no empty auth header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'audio/opus' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await generateTTS(
      {
        providerId: 'custom-tts-local',
        baseUrl: 'https://speech.example.com/team/v1',
        modelId: 'vendor/voice-model',
        voice: 'voice:teacher',
        speed: 1.25,
        format: 'opus',
      },
      'hello',
    );

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://speech.example.com/team/v1/audio/speech');
    expect(init.redirect).toBe('manual');
    expect(init.headers).not.toHaveProperty('Authorization');
    expect(JSON.parse(init.body)).toMatchObject({
      model: 'vendor/voice-model',
      voice: 'voice:teacher',
      response_format: 'opus',
    });
  });

  it('preserves ASR filename, MIME, bytes and selected model', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: 'recognized' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const file = new File([new Uint8Array([7, 8, 9])], 'recording.webm', {
      type: 'audio/webm;codecs=opus',
    });

    await expect(
      transcribeAudio(
        {
          providerId: 'custom-asr-gateway',
          baseUrl: 'https://speech.example.com/team/v1',
          apiKey: 'secret',
          modelId: 'vendor/asr-model',
          language: 'zh',
        },
        file,
      ),
    ).resolves.toEqual({ text: 'recognized' });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://speech.example.com/team/v1/audio/transcriptions');
    expect(init.redirect).toBe('manual');
    expect(init.headers).toEqual({ Authorization: 'Bearer secret' });
    const body = init.body as FormData;
    const sent = body.get('file') as File;
    expect(sent.name).toBe('recording.webm');
    expect(sent.type).toBe('audio/webm;codecs=opus');
    expect(new Uint8Array(await sent.arrayBuffer())).toEqual(new Uint8Array([7, 8, 9]));
    expect(body.get('model')).toBe('vendor/asr-model');
    expect(body.get('language')).toBe('zh');
  });
});
