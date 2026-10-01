import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  startFakeModelServer,
  type FakeModelServer,
} from '@/lib/model-gateway/testing/fake-openai-server';
import { GatewayError, userText } from '@/lib/model-gateway';
import { resetTransportAgents } from '@/lib/model-gateway/runtime/transport';
import { toNormalizedUsage } from '@/lib/model-gateway/runtime/usage';
import { bindingFor, testGateway } from './helpers';

let server: FakeModelServer;
beforeAll(async () => {
  server = await startFakeModelServer();
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => server.reset());
afterEach(async () => {
  vi.unstubAllEnvs();
  await resetTransportAgents();
});

const request = { messages: [userText('Hello', 0)] };

describe('usage normalization', () => {
  it('keeps the existing semantics: input includes cache read and write, no double counting', () => {
    expect(
      toNormalizedUsage({
        input: 10,
        output: 5,
        cacheRead: 3,
        cacheWrite: 6,
        reasoning: 2,
        totalTokens: 24,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      }),
    ).toEqual({
      inputTokens: 19,
      outputTokens: 5,
      cacheReadTokens: 3,
      cacheCreationTokens: 6,
      reasoningTokens: 2,
    });
  });

  it.each([
    [
      'OpenAI-compatible cache hit (DeepSeek)',
      'deepseek',
      'deepseek-flash',
      { input: 10, cacheRead: 4, output: 5 },
      { inputTokens: 14, cacheReadTokens: 4, cacheCreationTokens: 0, outputTokens: 5 },
    ],
    [
      'OpenAI Responses cached input',
      'openai',
      'gpt-5.4',
      { input: 10, cacheRead: 4, output: 5 },
      { inputTokens: 14, cacheReadTokens: 4, cacheCreationTokens: 0, outputTokens: 5 },
    ],
    [
      'Anthropic cache write + read',
      'anthropic',
      'claude-sonnet-4-5',
      { input: 10, cacheRead: 3, cacheWrite: 6, output: 5 },
      { inputTokens: 19, cacheReadTokens: 3, cacheCreationTokens: 6, outputTokens: 5 },
    ],
  ])('%s', async (_name, provider, model, usage, expected) => {
    server.setHandler(() => ({ kind: 'auto', text: 'ok', usage }));
    const harness = testGateway();
    const result = await harness.gateway.complete(
      await bindingFor(provider, model, server.origin),
      request,
      { source: 'usage-test', usage: { jobId: 'job-1', eventKey: 'evt' } },
    );
    expect(result.usage).toMatchObject(expected);
    expect(harness.usage).toEqual([
      expect.objectContaining({ usage: result.usage, jobId: 'job-1', eventKey: 'evt:1' }),
    ]);
  });
});

describe('sealed credentials', () => {
  it('sends the request key even when provider env keys are set', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-env-must-not-be-used');
    const harness = testGateway();
    await harness.gateway.complete(
      await bindingFor('deepseek', 'deepseek-flash', server.origin),
      request,
      { source: 'test' },
    );
    expect(server.requests[0]?.headers.authorization).toBe('Bearer sk-request-key');
  });

  it('never falls back to process.env when the binding has no key', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-env-must-not-be-used');
    vi.stubEnv('OPENAI_API_KEY', 'sk-env-must-not-be-used');
    const harness = testGateway();
    const error = await harness.gateway
      .complete(
        await bindingFor(
          'deepseek',
          'deepseek-flash',
          server.origin,
          {},
          { kind: 'operator', providerId: 'deepseek' },
        ),
        request,
        { source: 'test' },
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).code).toBe('MODEL_CONFIGURATION');
    expect(server.requests).toHaveLength(0);
  });
});

describe('transport safety for user endpoints', () => {
  it.each([
    ['IPv4 loopback', () => server.origin],
    ['IPv6 loopback', () => server.origin.replace('127.0.0.1', '[::1]')],
    ['private range', () => 'http://10.0.0.1:9'],
  ])('rejects %s without ALLOW_LOCAL_NETWORKS and sends nothing', async (_name, origin) => {
    const harness = testGateway();
    const error = await harness.gateway
      .complete(
        await bindingFor('deepseek', 'deepseek-flash', origin(), { endpoint: 'user' }),
        request,
        {
          source: 'test',
        },
      )
      .catch((caught: unknown) => caught);
    expect((error as GatewayError).code).toBe('MODEL_UNSAFE_ENDPOINT');
    expect(server.requests).toHaveLength(0);
    expect(harness.calls).toHaveLength(1);
  });

  it('allows local endpoints when ALLOW_LOCAL_NETWORKS=true', async () => {
    vi.stubEnv('ALLOW_LOCAL_NETWORKS', 'true');
    const harness = testGateway();
    const result = await harness.gateway.complete(
      await bindingFor('deepseek', 'deepseek-flash', server.origin, { endpoint: 'user' }),
      request,
      { source: 'test' },
    );
    expect(result.text).toBe('OK');
  });

  it('refuses to follow a redirect from a user endpoint', async () => {
    vi.stubEnv('ALLOW_LOCAL_NETWORKS', 'true');
    const target = await startFakeModelServer();
    try {
      server.setHandler(() => ({
        kind: 'raw',
        status: 307,
        headers: { location: `${target.origin}/chat/completions` },
        body: '',
      }));
      const harness = testGateway();
      const error = await harness.gateway
        .complete(
          await bindingFor('deepseek', 'deepseek-flash', server.origin, { endpoint: 'user' }),
          request,
          { source: 'test' },
        )
        .catch((caught: unknown) => caught);
      expect((error as GatewayError).code).toBe('MODEL_UNSAFE_ENDPOINT');
      expect(target.requests).toHaveLength(0);
    } finally {
      await target.close();
    }
  });

  it('routes operator endpoints through the configured proxy', async () => {
    let proxied = 0;
    const proxy: Server = createHttpServer((req, res) => {
      // Absolute-form forwarding for plain HTTP targets.
      proxied += 1;
      const target = new URL(req.url ?? '/');
      const upstream = httpRequest(
        {
          host: target.hostname,
          port: target.port,
          path: target.pathname + target.search,
          method: req.method,
          headers: req.headers,
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        },
      );
      req.pipe(upstream);
    });
    proxy.on('connect', (req, socket, head) => {
      proxied += 1;
      const [host, port] = (req.url ?? '').split(':');
      const upstream = connect(Number(port), host, () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on('error', () => socket.destroy());
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = proxy.address() as AddressInfo;
      const harness = testGateway();
      const result = await harness.gateway.complete(
        await bindingFor('deepseek', 'deepseek-flash', server.origin, {
          endpoint: 'operator',
          proxy: `http://127.0.0.1:${port}`,
        }),
        request,
        { source: 'test' },
      );
      expect(result.text).toBe('OK');
      expect(proxied).toBeGreaterThan(0);
    } finally {
      proxy.closeAllConnections();
      await new Promise((resolve) => proxy.close(resolve));
    }
  });
});
