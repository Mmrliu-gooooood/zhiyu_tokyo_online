/**
 * P2-5 (part 1): every case of tests/server/resolve-model.test.ts, asserted
 * against resolveBinding. provider-config is mocked with its real semantics
 * (an operator-configured provider uses the server key / URL; otherwise only
 * the client's), so assertions read the binding and its private credential.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelBinding } from '@/lib/model-gateway/types';

const mocks = vi.hoisted(() => ({
  serverManaged: false,
  ssrfBlocked: false,
  proxy: undefined as string | undefined,
}));

vi.mock('@/lib/server/provider-config', () => {
  class PlatformDefaultModelError extends Error {
    constructor(
      readonly code: string,
      readonly httpStatus: number,
      message: string,
    ) {
      super(message);
      this.name = 'PlatformDefaultModelError';
    }
  }
  return {
    PlatformDefaultModelError,
    isServerConfiguredProvider: () => mocks.serverManaged,
    resolveApiKey: (_id: string, clientKey?: string) =>
      mocks.serverManaged ? 'server-key' : clientKey || '',
    resolveBaseUrl: (_id: string, clientBaseUrl?: string) =>
      mocks.serverManaged ? undefined : clientBaseUrl,
    resolveProxy: () => (mocks.serverManaged ? mocks.proxy : undefined),
    resolvePlatformDefault: (defaultId: string) => ({
      source: 'platform',
      defaultId,
      capability: 'text',
      providerId: 'deepseek',
      modelId: 'deepseek-flash',
      displayName: 'DeepSeek V4.1 Flash',
      revision: 'revision-1',
      apiKey: 'platform-key',
      baseUrl: 'https://platform.example/v1',
      parameters: {},
      defaultThinkingConfig: { mode: 'disabled', effort: 'none' },
    }),
  };
});

vi.mock('@/lib/server/ssrf-guard', () => ({
  validateUrlForSSRF: async () => (mocks.ssrfBlocked ? 'blocked' : null),
}));

async function load() {
  const resolve = await import('@/lib/model-gateway/selection/resolve-binding');
  const read = await import('@/lib/model-gateway/selection/read-request');
  const handles = await import('@/lib/model-gateway/credentials/handles');
  const schema = await import('@/lib/model-gateway/selection/schema');
  const errors = await import('@/lib/model-gateway/selection/errors');
  return { ...resolve, ...read, ...handles, ...schema, ...errors };
}

/** Legacy resolveModel params → the request the new reader would see. */
interface LegacyParams {
  api?: string;
  modelString?: string;
  stage?: string;
  apiKey?: string;
  baseUrl?: string;
  providerType?: string;
  thinkingConfig?: Record<string, unknown>;
  source?: string;
  platformDefaultId?: string;
  defaultId?: string;
  revision?: string;
}

async function resolve(params: LegacyParams): Promise<ModelBinding> {
  const { resolveBinding, upgradeLegacyModelParams, ModelSelectionError } = await load();
  let request: {
    selection?: ReturnType<typeof upgradeLegacyModelParams>;
    thinking?: object;
    error?: unknown;
  };
  try {
    request = {
      selection: upgradeLegacyModelParams(params),
      ...(params.thinkingConfig ? { thinking: params.thinkingConfig } : {}),
    };
  } catch (error) {
    if (!(error instanceof ModelSelectionError)) throw error;
    request = { error };
  }
  return resolveBinding({ request: request as never, stage: params.stage });
}

async function credential(binding: ModelBinding) {
  return (await load()).getCredentialHandle(binding);
}

async function rejection(params: LegacyParams) {
  const { getBindingResolutionError } = await load();
  try {
    await resolve(params);
  } catch (error) {
    return getBindingResolutionError(error) ?? { thrown: error };
  }
  return undefined;
}

describe('resolveBinding — legacy resolveModel equivalence', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.serverManaged = false;
    mocks.ssrfBlocked = false;
    delete process.env.MODEL_ROUTES;
    delete process.env.DEFAULT_MODEL;
  });

  it('throws (no hardcoded fallback) when nothing is configured', async () => {
    expect(await rejection({ stage: 'scene-content' })).toMatchObject({
      code: 'MISSING_MODEL',
      httpStatus: 400,
      message: expect.stringMatching(/No model could be resolved/),
    });
  });

  it('passes the saved dialect to its own provider and replaces it with routed dialect', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({
      'scene-actions': { model: 'openai:routed', api: 'openai-completions' },
    });
    const personal = { modelString: 'openai:home', apiKey: 'home-key', api: 'openai-responses' };
    const home = await resolve({ ...personal, stage: 'scene-content' });
    expect(home).toMatchObject({ modelId: 'home', model: { api: 'openai-responses' } });
    expect(await credential(home)).toEqual({ kind: 'inline-key', apiKey: 'home-key' });

    mocks.serverManaged = true;
    const routed = await resolve({ ...personal, stage: 'scene-actions' });
    expect(routed).toMatchObject({ modelId: 'routed', model: { api: 'openai-completions' } });
    expect(await credential(routed)).toMatchObject({ kind: 'operator', apiKey: 'server-key' });
  });

  it('uses DEFAULT_MODEL when no stage route matches', async () => {
    process.env.DEFAULT_MODEL = 'openai:gpt-5.4-mini';
    expect((await resolve({ stage: 'scene-content' })).modelString).toBe('openai:gpt-5.4-mini');
  });

  it('uses the stage route over DEFAULT_MODEL', async () => {
    process.env.DEFAULT_MODEL = 'openai:gpt-5.4-mini';
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content': 'openai:gpt-5.4' });
    expect((await resolve({ stage: 'scene-content' })).modelString).toBe('openai:gpt-5.4');
  });

  it('uses DEFAULT_MODEL for stages not listed in MODEL_ROUTES', async () => {
    process.env.DEFAULT_MODEL = 'openai:gpt-5.4-mini';
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content': 'openai:gpt-5.4' });
    expect((await resolve({ stage: 'quiz-grade' })).modelString).toBe('openai:gpt-5.4-mini');
  });

  it('lets a configured stage route win over an explicit modelString (x-model)', async () => {
    process.env.DEFAULT_MODEL = 'openai:gpt-5.4-mini';
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content': 'openai:gpt-5.4' });
    const binding = await resolve({
      stage: 'scene-content',
      modelString: 'anthropic:claude-sonnet-4',
    });
    expect(binding).toMatchObject({
      modelString: 'openai:gpt-5.4',
      routedStage: 'scene-content',
    });
  });

  it('falls back to x-model for a stage that is not routed', async () => {
    process.env.DEFAULT_MODEL = 'openai:gpt-5.4-mini';
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content': 'openai:gpt-5.4' });
    const binding = await resolve({
      stage: 'quiz-grade',
      modelString: 'anthropic:claude-sonnet-4',
    });
    expect(binding.modelString).toBe('anthropic:claude-sonnet-4');
    expect(binding.routedStage).toBeUndefined();
  });

  it('exposes invalid source failures as a stable client error', async () => {
    expect(await rejection({ source: 'invalid-source' })).toEqual({
      code: 'INVALID_MODEL_SOURCE',
      httpStatus: 400,
      message: 'Invalid model source: invalid-source',
    });
  });

  it('expands a stable platform reference before provider parsing and drops client overrides', async () => {
    const binding = await resolve({
      modelString: 'openai:attacker-model',
      source: 'platform',
      platformDefaultId: 'zhiyu-default-text',
      apiKey: 'user-key',
      baseUrl: 'https://user.example/v1',
    });
    expect(binding).toMatchObject({
      modelString: 'platform:zhiyu-default-text',
      source: 'platform',
      defaultId: 'zhiyu-default-text',
      revision: 'revision-1',
      providerId: 'deepseek',
      modelId: 'deepseek-flash',
      model: { baseUrl: 'https://platform.example/v1' },
      funding: { kind: 'platform', defaultId: 'zhiyu-default-text', revision: 'revision-1' },
      endpoint: 'operator',
    });
    expect(await credential(binding)).toMatchObject({ kind: 'platform', apiKey: 'platform-key' });
  });

  it('rejects a stale platform revision before constructing a provider client', async () => {
    expect(
      await rejection({
        source: 'platform',
        defaultId: 'zhiyu-default-text',
        revision: 'stale-revision',
      }),
    ).toMatchObject({ code: 'PLATFORM_DEFAULT_REVISION_MISMATCH', httpStatus: 409 });
  });

  it('applies the platform default thinking policy and preserves a supported explicit override', async () => {
    const byDefault = await resolve({
      source: 'platform',
      defaultId: 'zhiyu-default-text',
      revision: 'revision-1',
    });
    const explicit = await resolve({
      source: 'platform',
      defaultId: 'zhiyu-default-text',
      revision: 'revision-1',
      thinkingConfig: { mode: 'enabled', effort: 'high' },
    });
    expect(byDefault.thinking).toEqual({ mode: 'disabled', effort: 'none' });
    expect(explicit.thinking).toEqual({ mode: 'enabled', effort: 'high' });
  });

  it('uses an explicit user key even when the same provider is server configured', async () => {
    mocks.serverManaged = true;
    const binding = await resolve({
      modelString: 'deepseek:my-model',
      source: 'user',
      apiKey: 'user-key',
      baseUrl: 'https://user.example/v1',
    });
    expect(binding).toMatchObject({
      providerId: 'deepseek',
      modelId: 'my-model',
      model: { baseUrl: 'https://user.example/v1' },
      endpoint: 'user',
      funding: { kind: 'byok' },
    });
    expect(await credential(binding)).toEqual({ kind: 'inline-key', apiKey: 'user-key' });
  });

  it('drops client apiKey/baseUrl/providerType when a stage route overrides the client model', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({ 'pbl-chat': 'anthropic:claude-sonnet-4' });
    mocks.serverManaged = true;
    const binding = await resolve({
      stage: 'pbl-chat',
      modelString: 'openai:gpt-5.4-mini',
      apiKey: 'client-openai-key',
      baseUrl: 'https://client.example/v1',
      providerType: 'openai',
    });
    expect(binding).toMatchObject({
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4',
      model: { api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com' },
      endpoint: 'operator',
    });
    expect(await credential(binding)).toMatchObject({ kind: 'operator', apiKey: 'server-key' });
  });

  it('keeps client apiKey/baseUrl/providerType for an unrouted stage (x-model honored)', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content': 'openai:gpt-5.4' });
    const binding = await resolve({
      stage: 'quiz-grade',
      modelString: 'openai:gpt-5.4-mini',
      apiKey: 'client-key',
      baseUrl: 'https://client.example/v1',
      providerType: 'openai',
    });
    expect(binding).toMatchObject({
      model: { baseUrl: 'https://client.example/v1', api: 'openai-completions' },
      endpoint: 'user',
    });
    expect(await credential(binding)).toEqual({ kind: 'inline-key', apiKey: 'client-key' });
  });

  it('rejects Bedrock unless the server operator explicitly enabled it', async () => {
    expect(
      await rejection({
        modelString: 'bedrock:us.anthropic.claude-sonnet-5',
        apiKey: 'client-supplied-token',
      }),
    ).toMatchObject({ code: 'MODEL_CONFIGURATION', httpStatus: 400 });
  });

  it('rejects a client-supplied Bedrock type for another built-in provider', async () => {
    expect(
      await rejection({ modelString: 'ollama:llama3.3', providerType: 'bedrock' }),
    ).toMatchObject({
      code: 'INVALID_MODEL_SELECTION',
      message: expect.stringMatching(/Provider type mismatch/),
    });
  });

  it('allows Bedrock after the server operator explicitly enables it', async () => {
    mocks.serverManaged = true;
    const binding = await resolve({ modelString: 'bedrock:us.anthropic.claude-sonnet-5' });
    expect(binding).toMatchObject({
      providerId: 'bedrock',
      modelId: 'us.anthropic.claude-sonnet-5',
      model: { api: 'bedrock-converse-stream' },
      endpoint: 'operator',
    });
  });

  it('uses a scene-content:<type> route over the base route and x-model', async () => {
    process.env.DEFAULT_MODEL = 'openai:gpt-5.4-mini';
    process.env.MODEL_ROUTES = JSON.stringify({
      'scene-content': 'openai:gpt-5.4-mini',
      'scene-content:quiz': 'openai:gpt-5.4',
    });
    const binding = await resolve({
      stage: 'scene-content:quiz',
      modelString: 'anthropic:claude-sonnet-4',
    });
    expect(binding.modelString).toBe('openai:gpt-5.4');
  });

  it('falls back to the base scene-content route for an unrouted type', async () => {
    process.env.DEFAULT_MODEL = 'openai:gpt-5.4-mini';
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content': 'openai:gpt-5.4' });
    expect((await resolve({ stage: 'scene-content:slide' })).modelString).toBe('openai:gpt-5.4');
  });

  it('resolves the stage route provider for cross-provider routing', async () => {
    process.env.DEFAULT_MODEL = 'openai:gpt-5.4-mini';
    process.env.MODEL_ROUTES = JSON.stringify({ 'pbl-chat': 'anthropic:claude-sonnet-4' });
    const binding = await resolve({ stage: 'pbl-chat' });
    expect(binding).toMatchObject({
      modelString: 'anthropic:claude-sonnet-4',
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4',
    });
  });

  it('route thinking wins over client thinking when the stage is routed', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({
      'pbl-chat': { model: 'anthropic:claude-sonnet-4', thinking: { effort: 'high' } },
    });
    const binding = await resolve({ stage: 'pbl-chat', thinkingConfig: { effort: 'low' } });
    expect(binding.thinking).toEqual({ effort: 'high' });
  });

  it('uses a routed platform binding default when the route omits thinking', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content': 'platform:zhiyu-default-text' });
    const binding = await resolve({
      stage: 'scene-content',
      thinkingConfig: { mode: 'enabled', effort: 'high' },
    });
    expect(binding.thinking).toEqual({ mode: 'disabled', effort: 'none' });
  });

  it('keeps explicit route thinking ahead of a platform binding default', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({
      'scene-content': {
        model: 'platform:zhiyu-default-text',
        thinking: { mode: 'enabled', effort: 'high' },
      },
    });
    expect((await resolve({ stage: 'scene-content' })).thinking).toEqual({
      mode: 'enabled',
      effort: 'high',
    });
  });

  it('route can pass a full thinking config (enabled + budgetTokens)', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({
      'scene-content:interactive': {
        model: 'qwen:qwen3.7-plus',
        thinking: { enabled: true, budgetTokens: 8000 },
      },
    });
    expect((await resolve({ stage: 'scene-content:interactive' })).thinking).toEqual({
      enabled: true,
      budgetTokens: 8000,
    });
  });

  it('carries the agent driver thinking toggle onto its resolved connection', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({
      'maic-agent-driver': {
        model: 'openai:deepseek-v4-flash-vision-exp',
        api: 'openai-completions',
        thinking: { enabled: true },
      },
    });
    expect(await resolve({ stage: 'maic-agent-driver' })).toMatchObject({
      providerId: 'openai',
      modelId: 'deepseek-v4-flash-vision-exp',
      model: { api: 'openai-completions' },
      thinking: { enabled: true },
    });
  });

  it('routed-without-thinking drops client thinking (routed model uses its default)', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content': 'deepseek:deepseek-v4-pro' });
    const binding = await resolve({ stage: 'scene-content', thinkingConfig: { effort: 'high' } });
    expect(binding.thinking).toBeUndefined();
  });

  it('unrouted stage keeps the client thinking config', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content': 'deepseek:deepseek-v4-pro' });
    const binding = await resolve({
      stage: 'quiz-grade',
      modelString: 'openai:gpt-5.4-mini',
      thinkingConfig: { effort: 'medium' },
    });
    expect(binding.thinking).toEqual({ effort: 'medium' });
  });

  it('ignores stage routing entirely when no stage is passed', async () => {
    process.env.DEFAULT_MODEL = 'openai:gpt-5.4-mini';
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content': 'openai:gpt-5.4' });
    expect((await resolve({})).modelString).toBe('openai:gpt-5.4-mini');
  });
});

describe('resolveBinding — gateway-era rules', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.serverManaged = false;
    mocks.ssrfBlocked = false;
    delete process.env.MODEL_ROUTES;
    delete process.env.DEFAULT_MODEL;
  });

  it('keeps client thinking for the DEFAULT_MODEL fallback (no x-model)', async () => {
    process.env.DEFAULT_MODEL = 'openai:gpt-5.4-mini';
    expect((await resolve({ thinkingConfig: { effort: 'low' } })).thinking).toEqual({
      effort: 'low',
    });
  });

  it('maps a legacy-managed request for the platform backing provider to the platform model', async () => {
    mocks.serverManaged = true;
    const binding = await resolve({ modelString: 'deepseek:deepseek-flash' });
    expect(binding).toMatchObject({ source: 'platform', defaultId: 'zhiyu-default-text' });
    expect(await rejection({ modelString: 'deepseek:some-other-model' })).toMatchObject({
      code: 'INVALID_MODEL_SOURCE',
      httpStatus: 400,
    });
  });

  it('freezes the binding and keeps the key out of every enumerable field', async () => {
    const binding = await resolve({
      modelString: 'deepseek:deepseek-flash',
      source: 'user',
      apiKey: 'sk-secret-value',
    });
    expect(Object.isFrozen(binding)).toBe(true);
    expect(JSON.stringify(binding)).not.toContain('sk-secret-value');
    expect(binding.credentialReady).toBe(true);
  });

  it('reports a missing user key as not ready instead of throwing', async () => {
    const binding = await resolve({ modelString: 'deepseek:deepseek-flash', source: 'user' });
    expect(binding.credentialReady).toBe(false);
  });

  it('resolves a user-defined OpenAI-compatible provider from its connection', async () => {
    const binding = await resolve({
      modelString: 'custom-gateway:my-model',
      source: 'user',
      apiKey: 'k',
      baseUrl: 'https://custom.example/v1',
      providerType: 'openai',
    });
    expect(binding).toMatchObject({
      upstream: 'custom',
      model: { api: 'openai-completions', baseUrl: 'https://custom.example/v1' },
      capabilities: { knownModel: false, tools: 'unknown' },
      transforms: { inlineThinkTags: true },
    });
    expect(
      await rejection({ modelString: 'custom-gateway:my-model', source: 'user', apiKey: 'k' }),
    ).toMatchObject({ code: 'MODEL_CONFIGURATION' });
  });

  it('rejects an unsafe user endpoint in production before any request', async () => {
    mocks.ssrfBlocked = true;
    vi.stubEnv('NODE_ENV', 'production');
    try {
      expect(
        await rejection({
          modelString: 'deepseek:deepseek-flash',
          source: 'user',
          apiKey: 'k',
          baseUrl: 'http://169.254.169.254/v1',
        }),
      ).toMatchObject({ code: 'MODEL_UNSAFE_ENDPOINT' });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('marks keyless local providers as local-funded with a local endpoint', async () => {
    const binding = await resolve({ modelString: 'ollama:llama3.3', source: 'user' });
    expect(binding).toMatchObject({
      endpoint: 'local',
      funding: { kind: 'local' },
      credentialReady: true,
      model: { baseUrl: 'http://localhost:11434/v1' },
      transforms: { inlineThinkTags: true },
    });
  });

  it('locks Google user endpoints to the official host (P2-6)', async () => {
    expect(
      await rejection({
        modelString: 'google:gemini-2.5-flash',
        source: 'user',
        apiKey: 'k',
        baseUrl: 'https://gemini-relay.example/v1beta',
      }),
    ).toMatchObject({ code: 'MODEL_UNSAFE_ENDPOINT', httpStatus: 400 });
    const official = await resolve({
      modelString: 'google:gemini-2.5-flash',
      source: 'user',
      apiKey: 'k',
    });
    expect(official).toMatchObject({
      endpoint: 'official',
      model: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
    });
  });

  it('keeps Vertex operator-only and custom providers off SDK transports (P2-6)', async () => {
    expect(
      await rejection({
        modelString: 'google-vertex:gemini-2.5-flash',
        source: 'user',
        apiKey: 'k',
      }),
    ).toMatchObject({ code: 'MODEL_CONFIGURATION' });
    for (const providerType of ['google', 'bedrock']) {
      expect(
        await rejection({
          modelString: 'custom-relay:any-model',
          source: 'user',
          apiKey: 'k',
          baseUrl: 'https://relay.example/v1',
          providerType,
        }),
      ).toMatchObject({ code: 'MODEL_CONFIGURATION' });
    }
  });

  it('refuses an operator-proxied Google binding instead of bypassing the proxy (P2-6)', async () => {
    mocks.serverManaged = true;
    mocks.proxy = 'http://proxy.internal:3128';
    try {
      expect(await rejection({ modelString: 'google:gemini-2.5-flash' })).toMatchObject({
        code: 'MODEL_CONFIGURATION',
      });
      // A proxied OpenAI-compatible operator provider keeps its proxy.
      const proxied = await resolve({ modelString: 'qwen:qwen3.7-plus' });
      expect(proxied).toMatchObject({ endpoint: 'operator', proxy: 'http://proxy.internal:3128' });
    } finally {
      mocks.proxy = undefined;
    }
  });

  it('requires the declared endpoint params before a Cloudflare binding is ready', async () => {
    const { resolveBinding, readModelSelection } = await load();
    const headers = (params: Record<string, string>) => ({ headers: new Headers(params) });
    const missing = await resolveBinding({
      request: readModelSelection(
        headers({
          'x-model': 'cloudflare-workers-ai:@cf/openai/gpt-oss-120b',
          'x-model-source': 'user',
          'x-api-key': 'cf-key',
        }),
      ),
    });
    expect(missing.credentialReady).toBe(false);
    const ready = await resolveBinding({
      request: readModelSelection(
        headers({
          'x-model': 'cloudflare-workers-ai:@cf/openai/gpt-oss-120b',
          'x-model-source': 'user',
          'x-api-key': 'cf-key',
          'x-model-endpoint-params': JSON.stringify({
            CLOUDFLARE_ACCOUNT_ID: 'acct-1',
            UNRELATED: 'dropped',
          }),
        }),
      ),
    });
    expect(ready).toMatchObject({
      credentialReady: true,
      requestEnv: { CLOUDFLARE_ACCOUNT_ID: 'acct-1' },
    });
    expect(ready.requestEnv).not.toHaveProperty('UNRELATED');
  });
});
