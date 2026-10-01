/**
 * P2-7 "environment poisoning": every variable pi may read directly
 * (AWS / Google / Azure / proxy / PI_CACHE_RETENTION) and every provider key
 * is set to a sentinel. Each user-reachable wire API, called through real
 * bindings, must send only the request's own key to the binding's host;
 * nothing may carry a sentinel. Keyless or operator-only user bindings must
 * make zero requests.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PI_AUTH_ENV,
  PI_DIRECT_ENV,
  auditPiEnvironment,
  operatorProviderEnv,
} from '@/lib/model-gateway/credentials/env-exposure';
import { userText } from '@/lib/model-gateway/messages';
import { GatewayError } from '@/lib/model-gateway/runtime/errors';
import { readModelSelection } from '@/lib/model-gateway/selection/read-request';
import {
  getBindingResolutionError,
  resolveBinding,
} from '@/lib/model-gateway/selection/resolve-binding';
import {
  startFakeModelServer,
  type FakeModelServer,
} from '@/lib/model-gateway/testing/fake-openai-server';
import type { ModelBinding } from '@/lib/model-gateway/types';
import { rerouteBinding, testGateway } from './helpers';

const SENTINEL = 'sentinel-poison';
const UNREACHABLE_PROXY = 'http://127.0.0.1:9';
const saved: Record<string, string | undefined> = {};

function poison(): void {
  for (const name of [...PI_DIRECT_ENV, ...PI_AUTH_ENV]) {
    saved[name] = process.env[name];
    process.env[name] = /PROXY/i.test(name)
      ? UNREACHABLE_PROXY
      : name === 'NO_PROXY' || name === 'no_proxy'
        ? 'sentinel-poison.invalid'
        : name === 'AZURE_OPENAI_BASE_URL'
          ? `https://${SENTINEL}.openai.azure.com/openai/v1`
          : `${SENTINEL}-${name}`;
  }
}

function restore(): void {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

let server: FakeModelServer;
beforeAll(async () => {
  process.env.ALLOW_LOCAL_NETWORKS = 'true';
  server = await startFakeModelServer();
  poison();
});
afterAll(async () => {
  restore();
  delete process.env.ALLOW_LOCAL_NETWORKS;
  await server.close();
});
beforeEach(() => server.reset());

function headers(values: Record<string, string>) {
  return { headers: new Headers(values) };
}

async function userBinding(values: Record<string, string>): Promise<ModelBinding> {
  return resolveBinding({
    request: readModelSelection(headers({ 'x-model-source': 'user', ...values })),
  });
}

const REQUEST_KEY = 'sk-request-key-0123456789';

const CASES: Array<{ name: string; api: string; headers: Record<string, string> }> = [
  {
    name: 'openai-completions',
    api: 'openai-completions',
    headers: { 'x-model': 'deepseek:deepseek-flash' },
  },
  { name: 'openai-responses', api: 'openai-responses', headers: { 'x-model': 'openai:gpt-5.5' } },
  {
    name: 'anthropic-messages',
    api: 'anthropic-messages',
    headers: { 'x-model': 'anthropic:claude-sonnet-4-5' },
  },
  {
    name: 'google-generative-ai',
    api: 'google-generative-ai',
    headers: { 'x-model': 'google:gemini-2.5-flash' },
  },
  {
    name: 'mistral-conversations',
    api: 'mistral-conversations',
    headers: { 'x-model': 'mistral:mistral-medium-latest' },
  },
  {
    name: 'azure-openai-responses',
    api: 'azure-openai-responses',
    headers: {
      'x-model': 'azure:gpt-5.4',
      'x-base-url': 'https://my-resource.openai.azure.com/openai',
    },
  },
  {
    name: 'cloudflare-workers-ai (endpoint params)',
    api: 'openai-completions',
    headers: {
      'x-model': 'cloudflare-workers-ai:@cf/openai/gpt-oss-120b',
      'x-model-endpoint-params': JSON.stringify({ CLOUDFLARE_ACCOUNT_ID: 'acct-request' }),
    },
  },
];

describe('environment poisoning (P2-7)', () => {
  it('sees the poisoned names in the startup audit (names only)', () => {
    const audit = auditPiEnvironment();
    expect(audit.direct).toEqual(
      expect.arrayContaining([
        'AWS_ACCESS_KEY_ID',
        'AZURE_OPENAI_BASE_URL',
        'HTTPS_PROXY',
        'PI_CACHE_RETENTION',
      ]),
    );
    expect(audit.credentials).toEqual(
      expect.arrayContaining(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']),
    );
    expect(JSON.stringify(audit)).not.toContain(SENTINEL);
  });

  it.each(CASES)('$name uses only the request key and the binding host', async (testCase) => {
    const binding = await userBinding({ ...testCase.headers, 'x-api-key': REQUEST_KEY });
    expect(binding.model.api).toBe(testCase.api);
    const { binding: rerouted, host } = rerouteBinding(binding, server.origin);
    const { gateway } = testGateway();
    await gateway
      .complete(
        rerouted,
        { messages: [userText('Hello', 1)] },
        { source: 'env-poisoning', retry: 'none' },
      )
      .catch(() => undefined);

    expect(server.requests).toHaveLength(1);
    const request = server.requests[0]!;
    const wire = JSON.stringify({
      path: request.path,
      query: request.query,
      headers: request.headers,
      body: request.body ?? request.rawBody,
    });
    expect(wire).toContain(REQUEST_KEY);
    expect(wire).not.toContain(SENTINEL);
    expect(host).not.toContain(SENTINEL);
    if (testCase.api === 'azure-openai-responses') {
      expect(host).toBe('my-resource.openai.azure.com');
      expect(request.path).toBe('/openai/v1/responses');
    }
    if (testCase.name.startsWith('cloudflare')) {
      expect(host).toBe('api.cloudflare.com');
      expect(rerouted.requestEnv).toEqual({ CLOUDFLARE_ACCOUNT_ID: 'acct-request' });
    }
  });

  it.each(CASES)('$name without a key makes zero requests', async (testCase) => {
    const binding = await userBinding(testCase.headers);
    expect(binding.credentialReady).toBe(false);
    const { gateway } = testGateway();
    const error = await gateway
      .complete(
        binding,
        { messages: [userText('Hello', 1)] },
        { source: 'env-poisoning', retry: 'none' },
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).code).toBe('MODEL_CONFIGURATION');
    expect((error as GatewayError).requestSent).toBe(false);
    expect(server.requests).toHaveLength(0);
  });

  it('refuses user selections of ambient-credential providers before any request', async () => {
    for (const model of [
      'bedrock:us.anthropic.claude-sonnet-5',
      'google-vertex:gemini-2.5-flash',
    ]) {
      let failure: unknown;
      try {
        await userBinding({ 'x-model': model, 'x-api-key': REQUEST_KEY });
      } catch (error) {
        failure = error;
      }
      expect(getBindingResolutionError(failure)).toMatchObject({ code: 'MODEL_CONFIGURATION' });
    }
    expect(server.requests).toHaveLength(0);
  });
});

describe('explicit operator settings (P2-7)', () => {
  it('reads Bedrock region and Vertex project / location once, with legacy precedence', () => {
    expect(
      operatorProviderEnv('bedrock-converse-stream', {
        BEDROCK_REGION: 'eu-west-1',
        AWS_REGION: 'us-west-2',
      }),
    ).toEqual({
      env: { AWS_REGION: 'eu-west-1' },
      ready: true,
    });
    expect(operatorProviderEnv('bedrock-converse-stream', {})).toEqual({
      env: { AWS_REGION: 'us-east-1' },
      ready: true,
    });
    expect(
      operatorProviderEnv('google-vertex', {
        GCLOUD_PROJECT: 'p',
        GOOGLE_CLOUD_LOCATION: 'us-central1',
      }),
    ).toEqual({
      env: { GOOGLE_CLOUD_PROJECT: 'p', GOOGLE_CLOUD_LOCATION: 'us-central1' },
      ready: true,
    });
    // A Vertex binding without project / location is not ready (refused before sending).
    expect(operatorProviderEnv('google-vertex', { GOOGLE_CLOUD_PROJECT: 'p' }).ready).toBe(false);
  });
});
