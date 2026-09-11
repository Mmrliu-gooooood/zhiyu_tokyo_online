import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

describe('voice registration source isolation', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('uses an explicit user key even when the same TTS provider is server managed', async () => {
    vi.stubEnv('TTS_QWEN_API_KEY', 'platform-key-must-not-be-used');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          output: {
            total_count: 1,
            voice_list: [{ voice: 'voice-1', target_model: 'qwen3-tts-vc-2026-01-22' }],
          },
        }),
      ),
    );
    const { POST } = await import('@/app/api/generate/voice/route');
    const response = await POST(
      new NextRequest('http://localhost/api/generate/voice', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          modelSource: 'user',
          providerId: 'qwen-tts',
          voiceId: 'voice-1',
          referenceAudioBase64: 'unused-when-voice-exists',
          refText: 'Reference transcript.',
          ttsApiKey: 'caller-owned-key',
          ttsModelId: 'qwen3-tts-vc-test',
        }),
      }),
    );

    expect(response.status).toBe(200);
    const headers = new Headers(fetchSpy.mock.calls[0][1]?.headers);
    expect(headers.get('authorization')).toBe('Bearer caller-owned-key');
    expect(JSON.stringify(fetchSpy.mock.calls[0])).not.toContain('platform-key-must-not-be-used');
  });
});
