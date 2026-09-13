import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  generateTTS,
  TTSProviderTerminalError,
  TTSProviderTransientError,
  TTSRateLimitError,
} from '@/lib/audio/tts-providers';
import type { TTSModelConfig } from '@/lib/audio/types';

const config: TTSModelConfig = {
  providerId: 'minimax-tts',
  apiKey: 'secret-key',
  voice: 'test-voice',
  baseUrl: 'https://tts.test',
};
const success = () =>
  Response.json({
    base_resp: { status_code: 0 },
    data: { audio: 'FF0010ab', status: 2 },
    extra_info: { audio_format: 'wav' },
  });

describe('MiniMax response safety', () => {
  afterEach(() => vi.restoreAllMocks());

  it('preserves valid audio bytes, requested payload and returned format', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(success());
    await expect(generateTTS(config, 'private narration')).resolves.toEqual({
      audio: new Uint8Array([255, 0, 16, 171]),
      format: 'wav',
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][1]?.redirect).toBeUndefined();
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({
      text: 'private narration',
      stream: false,
      output_format: 'hex',
      voice_setting: { voice_id: 'test-voice' },
    });
  });

  it.each([
    [1002, TTSRateLimitError],
    [2045, TTSRateLimitError],
    [1004, TTSProviderTerminalError],
    [1008, TTSProviderTerminalError],
    [2013, TTSProviderTerminalError],
    [2049, TTSProviderTerminalError],
    [1024, TTSProviderTransientError],
    [1033, TTSProviderTransientError],
  ])('classifies documented business code %s without response-body leakage', async (code, cls) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        trace_id: 'trace-123',
        base_resp: { status_code: code, status_msg: 'secret-key private narration' },
        data: null,
      }),
    );
    const error = await generateTTS(config, 'private narration').catch((error: unknown) => error);
    expect(error).toBeInstanceOf(cls);
    expect(error).toMatchObject({
      provider: 'minimax-tts',
      httpStatus: 200,
      providerCode: code,
      traceId: 'trace-123',
      responseReceived: true,
      phase: 'response',
    });
    expect(String(error)).not.toContain('secret-key');
    expect(JSON.stringify(error)).not.toContain('private narration');
  });

  it.each([
    { base_resp: { status_code: 0 }, data: null },
    { base_resp: { status_code: 1000 } },
    { base_resp: { status_code: 1001 } },
    { base_resp: { status_code: 998877 } },
    { data: { audio: '0011' } },
    { base_resp: { status_code: '0' }, data: { audio: '0011' } },
    ...['', '  ', '0', '00zz', '0x', '00 11'].map((audio) => ({
      base_resp: { status_code: 0 },
      data: { audio },
    })),
  ])('retains unknown-result protection for malformed or ambiguous response %#', async (body) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(body));
    await expect(generateTTS(config, 'private narration')).rejects.toMatchObject({
      code: 'TTS_INVALID_RESPONSE',
      retryClassification: 'unknown',
      responseReceived: true,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('keeps malformed JSON unknown and accepts only bounded safe trace identifiers', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('private invalid body', {
        headers: { trace_id: 'trace-123' },
      }),
    );
    await expect(generateTTS(config, 'private narration')).rejects.toMatchObject({
      code: 'TTS_INVALID_RESPONSE',
      traceId: 'trace-123',
      httpStatus: 200,
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        base_resp: { status_code: 1004 },
        trace_id: 'private narration\nsecret-key',
      }),
    );
    const error = await generateTTS(config, 'private narration').catch((error: unknown) => error);
    expect(error).not.toHaveProperty('traceId', 'private narration\nsecret-key');
    expect(JSON.stringify(error)).not.toContain('secret-key');
  });
});

describe('MiniMax bounded pre-send DNS retry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  const dnsError = () =>
    new TypeError('fetch failed', {
      cause: Object.assign(new Error('DNS failed'), { code: 'EAI_AGAIN', syscall: 'getaddrinfo' }),
    });

  it('leaves ordinary mode single-attempt behavior unchanged', async () => {
    const failure = dnsError();
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(failure);
    await expect(generateTTS(config, 'text')).rejects.toBe(failure);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('retries at most twice within one combined signal', async () => {
    vi.useFakeTimers();
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(dnsError())
      .mockRejectedValueOnce(dnsError())
      .mockResolvedValue(success());
    const result = expect(
      generateTTS({ ...config, retryPreSendDns: true }, 'text'),
    ).resolves.toHaveProperty('format', 'wav');
    await vi.runAllTimersAsync();
    await result;
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(new Set(fetch.mock.calls.map((call) => call[1]?.signal)).size).toBe(1);
    expect(fetch.mock.calls.every((call) => call[1]?.redirect === 'error')).toBe(true);
  });

  it('stops after three failed pre-send attempts', async () => {
    vi.useFakeTimers();
    const failure = dnsError();
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(failure);
    const result = generateTTS({ ...config, retryPreSendDns: true }, 'text').catch(
      (error: unknown) => error,
    );
    await vi.runAllTimersAsync();
    expect(await result).toBe(failure);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'])(
    'does not retry ambiguous transport %s',
    async (code) => {
      const failure = Object.assign(new Error('transport failed'), { code });
      const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(failure);
      await expect(generateTTS({ ...config, retryPreSendDns: true }, 'text')).rejects.toBe(failure);
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it('does not retry DNS after a response was received', async () => {
    const response = success();
    vi.spyOn(response, 'json').mockRejectedValue(dnsError());
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    await expect(generateTTS({ ...config, retryPreSendDns: true }, 'text')).rejects.toMatchObject({
      code: 'TTS_INVALID_RESPONSE',
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('honors cancellation during DNS backoff', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(dnsError());
    const result = generateTTS(
      { ...config, retryPreSendDns: true, signal: controller.signal },
      'text',
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ name: 'AbortError' });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('does not reset the request deadline on DNS retry', async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('Expired', 'TimeoutError')), 400);
      return controller.signal;
    });
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(dnsError());
    const result = generateTTS({ ...config, retryPreSendDns: true }, 'text').catch(
      (error: unknown) => error,
    );
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ code: 'TTS_RESULT_UNKNOWN_AFTER_TIMEOUT' });
    expect(timeout).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
