/**
 * Error classification and the bounded retry table (plan 3.8) against the
 * fake server, in foreground and background (GENERATION_BACKGROUND_ENABLED)
 * modes.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  startFakeModelServer,
  type FakeModelServer,
  type FakeReply,
} from '@/lib/model-gateway/testing/fake-openai-server';
import { GatewayError, userText } from '@/lib/model-gateway';
import { bindingFor, testGateway } from './helpers';

let server: FakeModelServer;
beforeAll(async () => {
  server = await startFakeModelServer();
  // One throwaway call loads the pi provider / API modules up front. Under a
  // loaded full run that cold load could exceed the first test's 5 s budget,
  // and its late request would then be counted by the next test.
  server.setHandler(() => ({ kind: 'auto', text: 'ok' }));
  await testGateway().gateway.complete(
    await bindingFor('deepseek', 'deepseek-flash', server.origin),
    request,
    { source: 'warm-up' },
  );
}, 60_000);
afterAll(async () => {
  await server.close();
});
beforeEach(() => server.reset());
afterEach(() => vi.unstubAllEnvs());

const request = { messages: [userText('Hello', 0)] };

async function run(reply: FakeReply | (() => FakeReply), background = false) {
  if (background) vi.stubEnv('GENERATION_BACKGROUND_ENABLED', '1');
  server.setHandler(typeof reply === 'function' ? reply : () => reply);
  const harness = testGateway();
  const binding = await bindingFor('deepseek', 'deepseek-flash', server.origin);
  const outcome = await harness.gateway
    .complete(binding, request, { source: 'test' })
    .then((result) => ({ result, error: undefined }))
    .catch((error: unknown) => ({ result: undefined, error: error as GatewayError }));
  return { ...outcome, harness, requests: server.requests.length };
}

describe('error classification', () => {
  it.each([
    [401, 'MODEL_AUTH_FAILED'],
    [403, 'MODEL_AUTH_FAILED'],
    [404, 'MODEL_NOT_FOUND'],
    [400, 'MODEL_BAD_REQUEST'],
    [422, 'MODEL_BAD_REQUEST'],
  ] as const)('HTTP %i → %s without retries', async (status, code) => {
    const { error, requests, harness } = await run({ kind: 'error', status });
    expect(error).toBeInstanceOf(GatewayError);
    expect(error?.code).toBe(code);
    expect(error?.status).toBe(status);
    expect(error?.requestSent).toBe(true);
    expect(requests).toBe(1);
    expect(harness.usage).toHaveLength(1);
  });

  it('classifies a context-length 400 as MODEL_CONTEXT_OVERFLOW', async () => {
    const { error } = await run({
      kind: 'error',
      status: 400,
      body: {
        error: {
          message:
            "This model's maximum context length is 128000 tokens. However, your messages resulted in 200000 tokens.",
          type: 'invalid_request_error',
          code: 'context_length_exceeded',
        },
      },
    });
    expect(error?.code).toBe('MODEL_CONTEXT_OVERFLOW');
  });

  it('keeps upstream bodies out of the error message and JSON', async () => {
    const { error } = await run({
      kind: 'error',
      status: 401,
      body: { error: { message: 'invalid key sk-leaked-secret at https://internal.example' } },
    });
    expect(error?.message).not.toContain('sk-leaked-secret');
    expect(JSON.stringify(error)).not.toContain('sk-leaked-secret');
    expect(JSON.stringify(error)).not.toContain('internal.example');
  });

  it('exposes limiter-compatible statusCode / responseHeaders for 429', async () => {
    const { error } = await run(
      { kind: 'error', status: 429, headers: { 'retry-after': '30' } },
      true,
    );
    expect(error?.code).toBe('MODEL_RATE_LIMITED');
    expect(error?.retryAfterMs).toBe(30_000);
    expect(error?.statusCode).toBe(429);
    expect(error?.responseHeaders).toEqual({ 'retry-after': '30' });
  });
});

describe('retry table', () => {
  it('429 with a short retry-after: two foreground retries, none in background', async () => {
    const foreground = await run({ kind: 'error', status: 429, headers: { 'retry-after': '1' } });
    expect(foreground.requests).toBe(3);
    expect(foreground.harness.sleeps).toEqual([1000, 1000]);
    expect(foreground.error?.code).toBe('MODEL_RATE_LIMITED');

    server.reset();
    const background = await run(
      { kind: 'error', status: 429, headers: { 'retry-after': '1' } },
      true,
    );
    expect(background.requests).toBe(1);
  });

  it('429 with a long retry-after is not retried in the foreground', async () => {
    const { requests } = await run({
      kind: 'error',
      status: 429,
      headers: { 'retry-after': '60' },
    });
    expect(requests).toBe(1);
  });

  it('5xx: two foreground retries with backoff, none in background', async () => {
    const foreground = await run({ kind: 'error', status: 503 });
    expect(foreground.requests).toBe(3);
    expect(foreground.harness.sleeps).toEqual([500, 1500]);
    expect(foreground.error?.code).toBe('MODEL_UPSTREAM_UNAVAILABLE');
    expect(foreground.harness.usage).toHaveLength(3);

    server.reset();
    const background = await run({ kind: 'error', status: 503 }, true);
    expect(background.requests).toBe(1);
  });

  it('recovers when a retry succeeds', async () => {
    let calls = 0;
    const { result, requests } = await run(() =>
      ++calls === 1 ? { kind: 'error', status: 502 } : { kind: 'auto', text: 'recovered' },
    );
    expect(result?.text).toBe('recovered');
    expect(result?.attempts).toBe(2);
    expect(requests).toBe(2);
  });

  it('a connection reset before any output is retried only in the foreground', async () => {
    const foreground = await run({ kind: 'reset' });
    expect(foreground.error?.code).toBe('MODEL_NETWORK');
    expect(foreground.requests).toBe(3);

    server.reset();
    const background = await run({ kind: 'reset' }, true);
    expect(background.requests).toBe(1);
  });

  it('never retries after output was observed (200 then disconnect)', async () => {
    const { error, requests } = await run({
      kind: 'auto',
      text: 'partial answer that is cut off',
      textChunks: 6,
      disconnectAfterEvents: 3,
    });
    expect(error?.outputObserved).toBe(true);
    expect(error?.code).toBe('MODEL_NETWORK');
    expect(requests).toBe(1);
  });

  it(
    'DNS failures are retried twice in both modes (the request never left)',
    { timeout: 60_000 },
    async () => {
      for (const background of [false, true]) {
        if (background) vi.stubEnv('GENERATION_BACKGROUND_ENABLED', '1');
        const harness = testGateway();
        const binding = await bindingFor(
          'deepseek',
          'deepseek-flash',
          'http://model-gateway-test.invalid',
        );
        const error = await harness.gateway
          .complete(binding, request, { source: 'test' })
          .catch((caught: GatewayError) => caught);
        expect(error).toBeInstanceOf(GatewayError);
        expect((error as GatewayError).code).toBe('MODEL_NETWORK');
        expect((error as GatewayError).requestSent).toBe(false);
        expect((error as GatewayError).safeToRetry).toBe(true);
        expect(harness.calls).toHaveLength(3);
        expect(harness.sleeps).toEqual([1000, 3000]);
      }
    },
  );

  it('cancellation is not retried and reports MODEL_ABORTED', async () => {
    server.setHandler(() => ({ kind: 'auto', text: 'slow', firstByteDelayMs: 2_000 }));
    const harness = testGateway();
    const binding = await bindingFor('deepseek', 'deepseek-flash', server.origin);
    const controller = new AbortController();
    const pending = harness.gateway.complete(binding, request, {
      source: 'test',
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({ code: 'MODEL_ABORTED' });
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]?.status).toBe('aborted');
  });
});
