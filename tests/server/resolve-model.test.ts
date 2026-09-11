import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the heavy downstream of resolveModel so the test isolates the model
// string *resolution order*: stage route > x-model > DEFAULT_MODEL > builtin.
// model-routes is left real (it just reads MODEL_ROUTES) so we exercise the
// real integration point.
// Use the real parseModelString (canonical `provider:model` colon format) so
// the test exercises actual separator handling; only stub getModel (recording
// its args) so no real provider client is constructed. provider-config stubs
// echo the client-supplied key/baseUrl so a test can assert they are dropped
// when a stage route overrides the client model.
const mocks = vi.hoisted(() => ({
  getModelCalls: [] as Array<Record<string, unknown>>,
  serverManaged: false,
}));

vi.mock('@/lib/ai/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/providers')>();
  return {
    ...actual,
    getModel: (args: Record<string, unknown>) => {
      mocks.getModelCalls.push(args);
      return { model: { id: args.modelId }, modelInfo: undefined };
    },
  };
});

vi.mock('@/lib/server/provider-config', () => {
  class PlatformDefaultModelError extends Error {
    constructor(
      readonly code: string,
      readonly httpStatus: number,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    PlatformDefaultModelError,
    isServerConfiguredProvider: () => mocks.serverManaged,
    resolveApiKey: (_id: string, clientKey: string) => clientKey || 'server-key',
    resolveBaseUrl: (_id: string, clientBaseUrl?: string) => clientBaseUrl,
    resolveProxy: () => undefined,
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
  validateUrlForSSRF: async () => null,
}));

describe('resolveModel — per-stage resolution order', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.getModelCalls.length = 0;
    mocks.serverManaged = false;
    delete process.env.MODEL_ROUTES;
    delete process.env.DEFAULT_MODEL;
  });

  it('throws (no hardcoded fallback) when nothing is configured', async () => {
    const { resolveModel } = await import('@/lib/server/resolve-model');
    await expect(resolveModel({ stage: 'scene-content' })).rejects.toThrow(
      /No model could be resolved/,
    );
  });

  it('passes the saved dialect to its own provider and replaces it with routed dialect', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({
      'scene-actions': { model: 'openai:routed', api: 'openai-completions' },
    });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const personal = {
      modelString: 'openai:home',
      apiKey: 'home-key',
      api: 'openai-responses' as const,
    };
    await resolveModel({ ...personal, stage: 'scene-content' });
    await resolveModel({ ...personal, stage: 'scene-actions' });
    expect(mocks.getModelCalls[0]).toMatchObject({
      modelId: 'home',
      apiKey: 'home-key',
      api: 'openai-responses',
    });
    expect(mocks.getModelCalls[1]).toMatchObject({
      modelId: 'routed',
      apiKey: 'server-key',
      api: 'openai-completions',
    });
  });

  it('uses DEFAULT_MODEL when no stage route matches', async () => {
    process.env.DEFAULT_MODEL = 'openai:gpt-5.4-mini';
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({ stage: 'scene-content' });
    expect(r.modelString).toBe('openai:gpt-5.4-mini');
  });

  it('uses the stage route over DEFAULT_MODEL', async () => {
    process.env.DEFAULT_MODEL = 'openai:gpt-5.4-mini';
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content': 'openai:gpt-5.4' });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({ stage: 'scene-content' });
    expect(r.modelString).toBe('openai:gpt-5.4');
  });

  it('uses DEFAULT_MODEL for stages not listed in MODEL_ROUTES', async () => {
    process.env.DEFAULT_MODEL = 'openai:gpt-5.4-mini';
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content': 'openai:gpt-5.4' });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({ stage: 'quiz-grade' });
    expect(r.modelString).toBe('openai:gpt-5.4-mini');
  });

  it('lets a configured stage route win over an explicit modelString (x-model)', async () => {
    process.env.DEFAULT_MODEL = 'openai:gpt-5.4-mini';
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content': 'openai:gpt-5.4' });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({
      stage: 'scene-content',
      modelString: 'anthropic:claude-sonnet-4',
    });
    expect(r.modelString).toBe('openai:gpt-5.4');
  });

  it('falls back to x-model for a stage that is not routed', async () => {
    process.env.DEFAULT_MODEL = 'openai:gpt-5.4-mini';
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content': 'openai:gpt-5.4' });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({ stage: 'quiz-grade', modelString: 'anthropic:claude-sonnet-4' });
    expect(r.modelString).toBe('anthropic:claude-sonnet-4');
  });

  it('exposes invalid source failures as a stable client error', async () => {
    const { getModelResolutionError, resolveModel } = await import('@/lib/server/resolve-model');
    let thrown: unknown;
    try {
      await resolveModel({ source: 'invalid-source' as 'user' });
    } catch (error) {
      thrown = error;
    }
    expect(getModelResolutionError(thrown)).toEqual({
      code: 'INVALID_MODEL_SOURCE',
      httpStatus: 400,
      message: 'Invalid model source: invalid-source',
    });
  });

  it('expands a stable platform reference before provider parsing and drops client overrides', async () => {
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const result = await resolveModel({
      modelString: 'openai:attacker-model',
      source: 'platform',
      platformDefaultId: 'zhiyu-default-text',
      apiKey: 'user-key',
      baseUrl: 'https://user.example/v1',
    });

    expect(result).toMatchObject({
      modelString: 'platform:zhiyu-default-text',
      source: 'platform',
      defaultId: 'zhiyu-default-text',
      revision: 'revision-1',
      providerId: 'deepseek',
      modelId: 'deepseek-flash',
    });
    expect(mocks.getModelCalls.at(-1)).toMatchObject({
      providerId: 'deepseek',
      modelId: 'deepseek-flash',
      apiKey: 'platform-key',
      baseUrl: 'https://platform.example/v1',
    });
  });

  it('rejects a stale platform revision before constructing a provider client', async () => {
    const { getModelResolutionError, resolveModel } = await import('@/lib/server/resolve-model');
    let thrown: unknown;
    try {
      await resolveModel({
        source: 'platform',
        defaultId: 'zhiyu-default-text',
        revision: 'stale-revision',
      });
    } catch (error) {
      thrown = error;
    }

    expect(getModelResolutionError(thrown)).toMatchObject({
      code: 'PLATFORM_DEFAULT_REVISION_MISMATCH',
      httpStatus: 409,
    });
    expect(mocks.getModelCalls).toHaveLength(0);
  });

  it('applies the platform default thinking policy and preserves a supported explicit override', async () => {
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const defaultResult = await resolveModel({
      source: 'platform',
      defaultId: 'zhiyu-default-text',
      revision: 'revision-1',
    });
    const explicitResult = await resolveModel({
      source: 'platform',
      defaultId: 'zhiyu-default-text',
      revision: 'revision-1',
      thinkingConfig: { mode: 'enabled', effort: 'high' },
    });

    expect(defaultResult.thinkingConfig).toEqual({ mode: 'disabled', effort: 'none' });
    expect(explicitResult.thinkingConfig).toEqual({ mode: 'enabled', effort: 'high' });
  });

  it('uses an explicit user key even when the same provider is server configured', async () => {
    mocks.serverManaged = true;
    const { resolveModel } = await import('@/lib/server/resolve-model');
    await resolveModel({
      modelString: 'deepseek:my-model',
      source: 'user',
      apiKey: 'user-key',
      baseUrl: 'https://user.example/v1',
    });

    expect(mocks.getModelCalls.at(-1)).toMatchObject({
      providerId: 'deepseek',
      modelId: 'my-model',
      apiKey: 'user-key',
      baseUrl: 'https://user.example/v1',
    });
  });

  it('drops client apiKey/baseUrl/providerType when a stage route overrides the client model', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({ 'pbl-chat': 'anthropic:claude-sonnet-4' });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    await resolveModel({
      stage: 'pbl-chat',
      modelString: 'openai:gpt-5.4-mini',
      apiKey: 'client-openai-key',
      baseUrl: 'https://client.example/v1',
      providerType: 'openai',
    });
    const call = mocks.getModelCalls.at(-1)!;
    expect(call.providerId).toBe('anthropic');
    expect(call.modelId).toBe('claude-sonnet-4');
    // None of the client-sent connection params for the OLD provider leak onto
    // the routed provider — they resolve from server config instead.
    expect(call.providerType).toBeUndefined();
    expect(call.baseUrl).toBeUndefined();
    expect(call.apiKey).toBe('server-key');
  });

  it('keeps client apiKey/baseUrl/providerType for an unrouted stage (x-model honored)', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content': 'openai:gpt-5.4' });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    await resolveModel({
      stage: 'quiz-grade',
      modelString: 'openai:gpt-5.4-mini',
      apiKey: 'client-key',
      baseUrl: 'https://client.example/v1',
      providerType: 'openai',
    });
    const call = mocks.getModelCalls.at(-1)!;
    expect(call.providerType).toBe('openai');
    expect(call.baseUrl).toBe('https://client.example/v1');
    expect(call.apiKey).toBe('client-key');
  });

  it('rejects Bedrock unless the server operator explicitly enabled it', async () => {
    const { resolveModel } = await import('@/lib/server/resolve-model');

    await expect(
      resolveModel({
        modelString: 'bedrock:us.anthropic.claude-sonnet-5',
        apiKey: 'client-supplied-token',
      }),
    ).rejects.toThrow(/must be enabled by the server operator/);
    expect(mocks.getModelCalls).toHaveLength(0);
  });

  it('rejects a client-supplied Bedrock type for another built-in provider', async () => {
    const { resolveModel } = await import('@/lib/server/resolve-model');

    await expect(
      resolveModel({
        modelString: 'ollama:llama3.3',
        providerType: 'bedrock',
      }),
    ).rejects.toThrow(/Provider type mismatch/);
    expect(mocks.getModelCalls).toHaveLength(0);
  });

  it('allows Bedrock after the server operator explicitly enables it', async () => {
    mocks.serverManaged = true;
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const result = await resolveModel({
      modelString: 'bedrock:us.anthropic.claude-sonnet-5',
    });

    expect(result.providerId).toBe('bedrock');
    expect(mocks.getModelCalls.at(-1)).toMatchObject({
      providerId: 'bedrock',
      modelId: 'us.anthropic.claude-sonnet-5',
    });
  });

  it('uses a scene-content:<type> route over the base route and x-model', async () => {
    process.env.DEFAULT_MODEL = 'openai:gpt-5.4-mini';
    process.env.MODEL_ROUTES = JSON.stringify({
      'scene-content': 'openai:gpt-5.4-mini',
      'scene-content:quiz': 'openai:gpt-5.4',
    });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({
      stage: 'scene-content:quiz',
      modelString: 'anthropic:claude-sonnet-4',
    });
    expect(r.modelString).toBe('openai:gpt-5.4');
  });

  it('falls back to the base scene-content route for an unrouted type', async () => {
    process.env.DEFAULT_MODEL = 'openai:gpt-5.4-mini';
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content': 'openai:gpt-5.4' });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({ stage: 'scene-content:slide' });
    expect(r.modelString).toBe('openai:gpt-5.4');
  });

  it('resolves the stage route provider for cross-provider routing', async () => {
    process.env.DEFAULT_MODEL = 'openai:gpt-5.4-mini';
    process.env.MODEL_ROUTES = JSON.stringify({ 'pbl-chat': 'anthropic:claude-sonnet-4' });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({ stage: 'pbl-chat' });
    expect(r.modelString).toBe('anthropic:claude-sonnet-4');
    expect(r.providerId).toBe('anthropic');
    expect(r.modelId).toBe('claude-sonnet-4');
  });

  it('route thinking wins over client thinking when the stage is routed', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({
      'pbl-chat': { model: 'anthropic:claude-sonnet-4', thinking: { effort: 'high' } },
    });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({ stage: 'pbl-chat', thinkingConfig: { effort: 'low' } });
    expect(r.thinkingConfig).toEqual({ effort: 'high' });
  });

  it('uses a routed platform binding default when the route omits thinking', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({
      'scene-content': 'platform:zhiyu-default-text',
    });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({
      stage: 'scene-content',
      thinkingConfig: { mode: 'enabled', effort: 'high' },
    });

    expect(r.thinkingConfig).toEqual({ mode: 'disabled', effort: 'none' });
  });

  it('keeps explicit route thinking ahead of a platform binding default', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({
      'scene-content': {
        model: 'platform:zhiyu-default-text',
        thinking: { mode: 'enabled', effort: 'high' },
      },
    });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({ stage: 'scene-content' });

    expect(r.thinkingConfig).toEqual({ mode: 'enabled', effort: 'high' });
  });

  it('route can pass a full thinking config (enabled + budgetTokens)', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({
      'scene-content:interactive': {
        model: 'qwen:qwen3.7-plus',
        thinking: { enabled: true, budgetTokens: 8000 },
      },
    });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({ stage: 'scene-content:interactive' });
    expect(r.thinkingConfig).toEqual({ enabled: true, budgetTokens: 8000 });
  });

  it('carries the agent driver thinking toggle onto its resolved connection', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({
      'maic-agent-driver': {
        model: 'openai:deepseek-v4-flash-vision-exp',
        api: 'openai-completions',
        thinking: { enabled: true },
      },
    });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({ stage: 'maic-agent-driver' });

    expect(r).toMatchObject({
      providerId: 'openai',
      modelId: 'deepseek-v4-flash-vision-exp',
      thinkingConfig: { enabled: true },
    });
  });

  it('routed-without-thinking drops client thinking (routed model uses its default)', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content': 'deepseek:deepseek-v4-pro' });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({ stage: 'scene-content', thinkingConfig: { effort: 'high' } });
    expect(r.thinkingConfig).toBeUndefined();
  });

  it('unrouted stage keeps the client thinking config', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content': 'deepseek:deepseek-v4-pro' });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({
      stage: 'quiz-grade',
      modelString: 'openai:gpt-5.4-mini',
      thinkingConfig: { effort: 'medium' },
    });
    expect(r.thinkingConfig).toEqual({ effort: 'medium' });
  });

  it('ignores stage routing entirely when no stage is passed', async () => {
    process.env.DEFAULT_MODEL = 'openai:gpt-5.4-mini';
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content': 'openai:gpt-5.4' });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({});
    expect(r.modelString).toBe('openai:gpt-5.4-mini');
  });
});
