/**
 * Gateway embedding calls (learning plan B03): request shape, strict vector
 * validation, bounded retry of transient failures, no retry of auth errors,
 * per-attempt operator-funded usage and logs, quota release, credentials never
 * in the binding's enumerable fields.
 */
import { describe, expect, it } from 'vitest';

import {
  createEmbeddingBinding,
  createEmbeddingGateway,
  GatewayError,
  type EmbeddingGatewayDeps,
} from '@/lib/model-gateway';
import type { UsageEvent } from '@/lib/model-gateway/runtime/usage';

const binding = createEmbeddingBinding(
  { providerId: 'siliconflow', modelId: 'BAAI/bge-m3', dimensions: 4, requestDimensions: true },
  { baseUrl: 'https://embed.example/v1/', apiKey: 'sk-secret' },
);

function setup(responses: Array<(body: Record<string, unknown>) => Response>) {
  const usage: UsageEvent[] = [];
  const logs: unknown[] = [];
  const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  let released = 0;
  const deps: Partial<EmbeddingGatewayDeps> = {
    recordUsage: (event) => usage.push(event),
    logCall: (line) => logs.push(line),
    sleep: async () => undefined,
    quota: async () => ({
      signal: new AbortController().signal,
      release: async () => void (released += 1),
    }),
    baseFetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      requests.push({ url: String(input), headers: new Headers(init?.headers), body });
      const next = responses.shift();
      if (!next) throw new Error('no response');
      return next(body);
    }) as typeof fetch,
  };
  return { gateway: createEmbeddingGateway(deps), usage, logs, requests, released: () => released };
}

const ok = (body: Record<string, unknown>) =>
  Response.json({
    data: (body.input as string[])
      .map((_, index) => ({ index, embedding: [index, 0, 0, 1] }))
      .reverse(),
    usage: { prompt_tokens: 7 },
  });

describe('embedding gateway', () => {
  it('posts an OpenAI-compatible request and orders vectors by index', async () => {
    const harness = setup([ok]);
    const result = await harness.gateway.embed(binding, ['甲', '乙'], {
      source: 'study-index',
      usage: { eventKey: 'task:1:0' },
    });
    expect(result).toEqual({
      vectors: [
        [0, 0, 0, 1],
        [1, 0, 0, 1],
      ],
      inputTokens: 7,
      attempts: 1,
    });
    expect(harness.requests[0]!.url).toBe('https://embed.example/v1/embeddings');
    expect(harness.requests[0]!.headers.get('authorization')).toBe('Bearer sk-secret');
    expect(harness.requests[0]!.body).toEqual({
      model: 'BAAI/bge-m3',
      input: ['甲', '乙'],
      encoding_format: 'float',
      dimensions: 4,
    });
    expect(harness.usage).toEqual([
      expect.objectContaining({
        source: 'study-index',
        fundingKind: 'operator',
        credentialKind: 'operator',
        api: 'openai-embeddings',
        status: 'ok',
        eventKey: 'task:1:0:1',
        usage: expect.objectContaining({ inputTokens: 7, outputTokens: 0 }),
      }),
    ]);
    expect(harness.released()).toBe(1);
    expect(JSON.stringify(binding)).not.toContain('sk-secret');
  });

  it('retries a 429 and a 503, then succeeds', async () => {
    const harness = setup([
      () => new Response('slow down', { status: 429, headers: { 'retry-after': '1' } }),
      () => new Response('down', { status: 503 }),
      ok,
    ]);
    const result = await harness.gateway.embed(binding, ['x'], { source: 'study-query' });
    expect(result.attempts).toBe(3);
    expect(harness.usage.map((event) => event.status)).toEqual(['error', 'error', 'ok']);
  });

  it('does not retry rejected credentials', async () => {
    const harness = setup([() => new Response('no', { status: 401 })]);
    await expect(harness.gateway.embed(binding, ['x'], { source: 's' })).rejects.toMatchObject({
      code: 'MODEL_AUTH_FAILED',
    });
    expect(harness.requests).toHaveLength(1);
    expect(harness.released()).toBe(1);
  });

  it('rejects vectors of the wrong width or count', async () => {
    const harness = setup([
      () => Response.json({ data: [{ index: 0, embedding: [1, 2] }] }),
      () => Response.json({ data: [] }),
    ]);
    await expect(harness.gateway.embed(binding, ['x'], { source: 's' })).rejects.toBeInstanceOf(
      GatewayError,
    );
    await expect(harness.gateway.embed(binding, ['x'], { source: 's' })).rejects.toMatchObject({
      code: 'MODEL_BAD_REQUEST',
    });
  });

  it('refuses bad inputs and an unconfigured key before any request', async () => {
    const harness = setup([]);
    await expect(harness.gateway.embed(binding, [], { source: 's' })).rejects.toMatchObject({
      code: 'MODEL_BAD_REQUEST',
    });
    const keyless = createEmbeddingBinding(
      { providerId: 'p', modelId: 'm', dimensions: 4 },
      { baseUrl: 'https://embed.example/v1', apiKey: '' },
    );
    await expect(harness.gateway.embed(keyless, ['x'], { source: 's' })).rejects.toMatchObject({
      code: 'MODEL_CONFIGURATION',
    });
    expect(harness.requests).toHaveLength(0);
  });

  it('reports unknown token usage as null and stops on abort', async () => {
    const harness = setup([() => Response.json({ data: [{ index: 0, embedding: [1, 1, 1, 1] }] })]);
    expect((await harness.gateway.embed(binding, ['x'], { source: 's' })).inputTokens).toBeNull();
    const controller = new AbortController();
    controller.abort();
    await expect(
      harness.gateway.embed(binding, ['x'], { source: 's', signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'MODEL_ABORTED' });
  });
});
