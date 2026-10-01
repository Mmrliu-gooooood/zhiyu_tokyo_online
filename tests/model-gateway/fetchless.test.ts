/**
 * P2-6: APIs whose pi adapter cannot take the gateway fetch (Google, Vertex,
 * Bedrock). Endpoint lock and pre-send refusal (zero requests), startup proxy
 * check, and error classification driven through the real pi adapters with
 * recorded upstream error shapes (no credentials).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { userText } from '@/lib/model-gateway/messages';
import { GatewayError } from '@/lib/model-gateway/runtime/errors';
import { fetchlessRefusal } from '@/lib/model-gateway/runtime/fetchless';
import { assertFetchlessProxyConfig } from '@/lib/model-gateway/startup';
import {
  startFakeModelServer,
  type FakeModelServer,
  type FakeReply,
} from '@/lib/model-gateway/testing/fake-openai-server';
import type { ModelBinding } from '@/lib/model-gateway/types';
import { bindingFor, testGateway } from './helpers';

let server: FakeModelServer;
beforeAll(async () => {
  server = await startFakeModelServer();
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => server.reset());

const GEMINI = 'gemini-2.5-flash';
const BEDROCK = 'global.anthropic.claude-sonnet-5';

async function googleBinding(overrides: Partial<ModelBinding> = {}) {
  return bindingFor('google', GEMINI, server.origin, { endpoint: 'operator', ...overrides });
}

async function bedrockBinding(overrides: Partial<ModelBinding> = {}) {
  return bindingFor(
    'amazon-bedrock',
    BEDROCK,
    server.origin,
    {
      endpoint: 'operator',
      // The AWS SDK speaks HTTP/2 by default; the fake server is HTTP/1.1.
      requestEnv: { AWS_BEDROCK_FORCE_HTTP1: '1', AWS_REGION: 'us-east-1' },
      ...overrides,
    },
    { kind: 'operator', providerId: 'bedrock', apiKey: 'test-bearer-token' },
  );
}

async function failure(binding: ModelBinding): Promise<GatewayError> {
  const { gateway } = testGateway();
  try {
    await gateway.complete(
      binding,
      { messages: [userText('Hello', 1)] },
      { source: 'fetchless-test', retry: 'none' },
    );
  } catch (error) {
    if (error instanceof GatewayError) return error;
    throw error;
  }
  throw new Error('expected a failure');
}

describe('fetch-less endpoint lock (invariant 4a)', () => {
  it.each([
    ['google user endpoint', { endpoint: 'user' as const }, 'MODEL_UNSAFE_ENDPOINT'],
    ['google local endpoint', { endpoint: 'local' as const }, 'MODEL_UNSAFE_ENDPOINT'],
    [
      'google official label on a foreign host',
      { endpoint: 'official' as const },
      'MODEL_UNSAFE_ENDPOINT',
    ],
    [
      'google operator endpoint behind a proxy',
      { proxy: 'http://proxy.internal:3128' },
      'MODEL_CONFIGURATION',
    ],
  ])('refuses a %s before any request', async (_label, overrides, code) => {
    const error = await failure(await googleBinding(overrides));
    expect(error.code).toBe(code);
    expect(error.requestSent).toBe(false);
    expect(server.requests).toHaveLength(0);
  });

  it('refuses Bedrock outside an operator binding before any request', async () => {
    for (const endpoint of ['official', 'user'] as const) {
      const error = await failure(await bedrockBinding({ endpoint }));
      expect(error.code).toBe('MODEL_CONFIGURATION');
    }
    expect(server.requests).toHaveLength(0);
  });

  it('allows the official Google host and operator endpoints', () => {
    const model = {
      api: 'google-generative-ai',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    };
    expect(
      fetchlessRefusal({ model: model as ModelBinding['model'], endpoint: 'official' }),
    ).toBeUndefined();
    expect(
      fetchlessRefusal({
        model: { ...model, baseUrl: 'https://gemini-relay.internal' } as ModelBinding['model'],
        endpoint: 'operator',
      }),
    ).toBeUndefined();
    expect(
      fetchlessRefusal({
        model: { api: 'openai-completions', baseUrl: 'https://x' } as ModelBinding['model'],
        endpoint: 'user',
      }),
    ).toBeUndefined();
  });
});

describe('startup proxy check', () => {
  it('fails with an explicit message when a fetch-less provider has a proxy', () => {
    expect(() =>
      assertFetchlessProxyConfig((id) => (id === 'google' ? 'http://proxy:3128' : undefined)),
    ).toThrow(/proxy is configured for google.*cannot go through the gateway proxy/);
    expect(() => assertFetchlessProxyConfig(() => undefined)).not.toThrow();
  });

  it('never prints the proxy URL (it may carry credentials)', () => {
    expect(() => assertFetchlessProxyConfig(() => 'http://user:secret@proxy:3128')).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('secret') }),
    );
  });
});

function googleError(
  status: number,
  rpcStatus: string,
  message: string,
  details: object[] = [],
): FakeReply {
  return {
    kind: 'raw',
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ error: { code: status, message, status: rpcStatus, details } }),
  };
}

function bedrockError(status: number, type: string, message: string): FakeReply {
  return {
    kind: 'raw',
    status,
    headers: {
      'content-type': 'application/json',
      'x-amzn-errortype': `${type}:http://internal.amazon.com/coral/com.amazon.bedrock/`,
      'x-amzn-requestid': '00000000-0000-0000-0000-000000000000',
    },
    body: JSON.stringify({ message }),
  };
}

describe('Google error classification (structured body first)', () => {
  it.each([
    [
      googleError(429, 'RESOURCE_EXHAUSTED', 'Resource has been exhausted (e.g. check quota).', [
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '30s' },
      ]),
      'MODEL_RATE_LIMITED',
      30_000,
    ],
    [
      googleError(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.', [
        { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' },
      ]),
      'MODEL_AUTH_FAILED',
      undefined,
    ],
    [
      googleError(403, 'PERMISSION_DENIED', 'Method not allowed for this key.'),
      'MODEL_AUTH_FAILED',
      undefined,
    ],
    [
      googleError(400, 'INVALID_ARGUMENT', 'Invalid JSON payload received.'),
      'MODEL_BAD_REQUEST',
      undefined,
    ],
    [
      googleError(404, 'NOT_FOUND', 'models/x is not found for API version v1beta.'),
      'MODEL_NOT_FOUND',
      undefined,
    ],
    [
      googleError(503, 'UNAVAILABLE', 'The model is overloaded. Please try again later.'),
      'MODEL_UPSTREAM_UNAVAILABLE',
      undefined,
    ],
  ] as const)('%#: %s', async (reply, code, retryAfterMs) => {
    server.setHandler(() => reply);
    const error = await failure(await googleBinding());
    expect(error.code).toBe(code);
    expect(error.retryAfterMs).toBe(retryAfterMs);
    expect(error.message).not.toMatch(/quota|API key|payload|overloaded/);
    expect(server.requests).toHaveLength(1);
  });
});

describe('Bedrock error classification (exception name first)', () => {
  it.each([
    [
      bedrockError(
        403,
        'AccessDeniedException',
        "You don't have access to the model with the specified model ID.",
      ),
      'MODEL_AUTH_FAILED',
    ],
    [
      bedrockError(400, 'ValidationException', 'The provided model identifier is invalid.'),
      'MODEL_BAD_REQUEST',
    ],
    [
      bedrockError(404, 'ResourceNotFoundException', 'Could not resolve the foundation model.'),
      'MODEL_NOT_FOUND',
    ],
    [
      bedrockError(400, 'ValidationException', 'Input is too long for requested model.'),
      'MODEL_CONTEXT_OVERFLOW',
    ],
  ] as const)('%#: %s', async (reply, code) => {
    server.setHandler(() => reply);
    const error = await failure(await bedrockBinding());
    expect(error.code).toBe(code);
    expect(server.requests).toHaveLength(1);
  });

  it(
    'classifies throttling and adds no gateway retry on top of the SDK retries',
    { timeout: 30_000 },
    async () => {
      server.setHandler(() => bedrockError(429, 'ThrottlingException', 'Too many requests.'));
      const { gateway, calls } = testGateway();
      const error = await gateway
        .complete(
          await bedrockBinding(),
          { messages: [userText('Hello', 1)] },
          { source: 'fetchless-test' },
        )
        .catch((caught: unknown) => caught as GatewayError);
      expect(error).toBeInstanceOf(GatewayError);
      expect((error as GatewayError).code).toBe('MODEL_RATE_LIMITED');
      // One gateway attempt; the AWS SDK's own standard retry (pi 0.99.1 does not
      // let the gateway disable it) makes at most 3 HTTP requests.
      expect(calls).toHaveLength(1);
      expect(server.requests.length).toBeGreaterThanOrEqual(1);
      expect(server.requests.length).toBeLessThanOrEqual(3);
    },
  );

  it('classifies a 5xx InternalServerException', { timeout: 30_000 }, async () => {
    server.setHandler(() => bedrockError(500, 'InternalServerException', 'Internal failure.'));
    expect((await failure(await bedrockBinding())).code).toBe('MODEL_UPSTREAM_UNAVAILABLE');
  });
});
