import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as GatewayModule from '@/lib/model-gateway';

/**
 * The PRO driver resolves through the gateway (resolveBinding with the
 * `maic-agent-driver` stage). Bindings come from the real catalog; single
 * tests override the resolver for capability edge cases.
 */
const mocks = vi.hoisted(() => ({
  override: undefined as
    | undefined
    | ((
        actual: typeof GatewayModule,
      ) => (...args: Parameters<typeof GatewayModule.resolveParamsBinding>) => unknown),
}));

/** Fresh modules per test: model-routes caches MODEL_ROUTES at first read. */
async function load() {
  vi.doMock('@/lib/model-gateway', async (importOriginal) => {
    const actual = await importOriginal<typeof GatewayModule>();
    return {
      ...actual,
      resolveParamsBinding: vi.fn((...args: Parameters<typeof actual.resolveParamsBinding>) =>
        mocks.override ? mocks.override(actual)(...args) : actual.resolveParamsBinding(...args),
      ),
    };
  });
  const gateway = await import('@/lib/model-gateway');
  const driver = await import('@/lib/server/agent-runtime/agent-driver-model');
  return { ...driver, resolveParamsBinding: vi.mocked(gateway.resolveParamsBinding), gateway };
}

const route = (entry: Record<string, unknown>) => {
  process.env.MODEL_ROUTES = JSON.stringify({ 'maic-agent-driver': entry });
};

describe('agent driver model', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.override = undefined;
    delete process.env.MODEL_ROUTES;
    delete process.env.DEFAULT_MODEL;
  });

  it('fails loud when neither a dedicated route nor a Home connection exists', async () => {
    const { resolveAgentDriverModel, resolveParamsBinding } = await load();
    await expect(resolveAgentDriverModel()).rejects.toThrow('must explicitly configure');
    expect(resolveParamsBinding).not.toHaveBeenCalled();
  });

  it('uses the Home connection and keeps its thinking effort', async () => {
    const { resolveAgentDriverModel, resolveParamsBinding } = await load();
    const home = {
      source: 'user' as const,
      modelString: 'deepseek:deepseek-flash',
      apiKey: 'home-secret',
      thinkingConfig: { mode: 'enabled' as const, effort: 'high' as const },
    };
    const driver = await resolveAgentDriverModel(home);

    expect(resolveParamsBinding).toHaveBeenCalledWith(home, 'maic-agent-driver');
    expect(driver.binding.thinking).toEqual({ mode: 'enabled', effort: 'high' });
    expect(driver.binding.credentialReady).toBe(true);
    // pi ids match the messages the gateway produces for this model.
    expect(driver.piModel).toMatchObject({
      id: driver.binding.model.id,
      api: driver.binding.model.api,
      provider: driver.binding.model.provider,
    });
    expect(JSON.stringify(driver)).not.toContain('home-secret');
  });

  it('accepts non-OpenAI protocols for the tool-using driver', async () => {
    const { resolveAgentDriverModel } = await load();
    const driver = await resolveAgentDriverModel({
      source: 'user',
      modelString: 'anthropic:claude-sonnet-4-5',
      apiKey: 'home-secret',
    });
    expect(driver.piModel.api).toBe('anthropic-messages');
  });

  it('does not send Home secrets into an explicitly routed driver', async () => {
    route({ model: 'deepseek:deepseek-flash' });
    const { resolveAgentDriverModel } = await load();
    const driver = await resolveAgentDriverModel({
      source: 'user',
      modelString: 'custom-home:home',
      apiKey: 'home-secret',
      baseUrl: 'https://home.example/v1',
    });
    expect(driver.binding).toMatchObject({
      providerId: 'deepseek',
      modelId: 'deepseek-flash',
      routedStage: 'maic-agent-driver',
    });
    // No operator key is configured in tests; the Home key was not borrowed.
    expect(driver.binding.credentialReady).toBe(false);
  });

  it('rejects a model reviewed as not supporting tools', async () => {
    mocks.override = (actual) => async (params, stage) => {
      const binding = await actual.resolveParamsBinding(params, stage);
      return { ...binding, capabilities: { ...binding.capabilities, tools: false } };
    };
    const { resolveAgentDriverModel } = await load();
    await expect(
      resolveAgentDriverModel({
        source: 'user',
        modelString: 'deepseek:deepseek-flash',
        apiKey: 'k',
      }),
    ).rejects.toThrow('PRO_MODEL_TOOLS');
  });

  it('drops the effort (keeps on/off) only for models that reject effort with tools', async () => {
    mocks.override = (actual) => async (params, stage) => {
      const binding = await actual.resolveParamsBinding(params, stage);
      // A reviewed flag on an otherwise real binding (same private credential handle).
      const { createBinding, getCredentialHandle } =
        await import('@/lib/model-gateway/credentials/handles');
      const { fingerprint: _fingerprint, credentialReady: _ready, ...fields } = binding;
      return createBinding(
        { ...fields, capabilities: { ...binding.capabilities, rejectsReasoningWithTools: true } },
        getCredentialHandle(binding),
      );
    };
    const home = await load();
    await expect(
      home.resolveAgentDriverModel({
        source: 'user',
        modelString: 'deepseek:deepseek-flash',
        apiKey: 'k',
        thinkingConfig: { mode: 'disabled', effort: 'none' },
      }),
    ).resolves.toMatchObject({ binding: { thinking: { mode: 'disabled' } } });

    vi.resetModules();
    route({ model: 'deepseek:deepseek-flash', thinking: { effort: 'medium' } });
    const routed = await load();
    await expect(routed.resolveAgentDriverModel()).rejects.toThrow('must not set thinking.effort');
  });

  it('requires an explicit provider prefix', async () => {
    route({ model: 'gpt-5.6-luna' });
    const { resolveAgentDriverModel, resolveParamsBinding } = await load();
    await expect(resolveAgentDriverModel()).rejects.toThrow('explicit provider prefix');
    expect(resolveParamsBinding).not.toHaveBeenCalled();
  });

  it('uses the catalog windows for a known model', async () => {
    route({ model: 'deepseek:deepseek-flash' });
    const { resolveAgentDriverModel } = await load();
    const resolved = await resolveAgentDriverModel();
    const { capabilities } = resolved.binding;

    expect(capabilities.knownModel).toBe(true);
    expect(resolved.piModel.contextWindow).toBe(capabilities.contextWindow);
    expect(resolved.piModel.maxTokens).toBe(capabilities.maxOutputTokens);
    expect(resolved.wireMaxOutputTokens).toBe(capabilities.maxOutputTokens);
    expect(resolved.reservedOutputTokens).toBe(capabilities.maxOutputTokens);
  });

  it('falls back to a conservative window and omits the wire cap for an unknown model', async () => {
    const { resolveAgentDriverModel } = await load();
    const resolved = await resolveAgentDriverModel({
      source: 'user',
      modelString: 'custom-home:some-model',
      apiKey: 'k',
      baseUrl: 'https://gateway.example/v1',
      api: 'openai-completions',
    });

    // A 1M fallback made pi's compaction threshold unreachable.
    expect(resolved.binding.capabilities.knownModel).toBe(false);
    expect(resolved.piModel.contextWindow).toBe(128_000);
    expect(resolved.piModel.maxTokens).toBe(8_192);
    expect(resolved.wireMaxOutputTokens).toBeUndefined();
    expect(resolved.reservedOutputTokens).toBe(8_192);
  });

  it('lets the route pin a contextWindow below the catalog value', async () => {
    route({ model: 'deepseek:deepseek-flash', contextWindow: 32_000 });
    const { resolveAgentDriverModel } = await load();
    const resolved = await resolveAgentDriverModel();
    expect(resolved.piModel.contextWindow).toBe(32_000);
  });

  it('propagates an unresolvable provider failure', async () => {
    route({ model: 'nonexistent-provider:model' });
    const { resolveAgentDriverModel } = await load();
    await expect(resolveAgentDriverModel()).rejects.toMatchObject({
      name: 'GatewayError',
      code: 'MODEL_CONFIGURATION',
    });
  });
});
