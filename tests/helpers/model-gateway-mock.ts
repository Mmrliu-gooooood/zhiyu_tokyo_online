/**
 * Module mock for `@/lib/model-gateway` in business-route tests: the real
 * module, with `gateway.complete` / `gateway.stream` and the binding resolvers
 * replaced by the test's own vi.fn()s.
 *
 *   const mocks = vi.hoisted(() => ({ complete: vi.fn(), resolveRequestBinding: vi.fn() }));
 *   vi.mock('@/lib/model-gateway', async (importOriginal) =>
 *     (await import('@/tests/helpers/model-gateway-mock')).mockGatewayModule(
 *       await importOriginal(),
 *       mocks,
 *     ),
 *   );
 *
 * `complete` mocks may resolve to a partial result (`{ text }`); the rest of
 * the GatewayResult is filled in.
 */
import type * as GatewayModule from '@/lib/model-gateway';
import type { BindingFields } from '@/lib/model-gateway';
import type { Mock } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- vi.fn() of any signature
type AnyMock = Mock<(...args: any[]) => any>;

export interface GatewayModuleMocks {
  complete?: AnyMock;
  stream?: AnyMock;
  resolveBinding?: AnyMock;
  resolveRequestBinding?: AnyMock;
  resolveHeaderBinding?: AnyMock;
  resolveParamsBinding?: AnyMock;
}

const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  reasoningTokens: 0,
};

export function completeResult(partial: Record<string, unknown> = {}) {
  return {
    text: '',
    reasoningText: '',
    toolCalls: [],
    stopReason: 'stop',
    attempts: 1,
    message: { role: 'assistant', content: [] },
    ...partial,
    usage: { ...ZERO_USAGE, ...(partial.usage as object | undefined) },
  };
}

export function mockGatewayModule(actual: typeof GatewayModule, mocks: GatewayModuleMocks) {
  const gateway = {
    ...actual.gateway,
    ...(mocks.complete
      ? {
          complete: async (...args: unknown[]) =>
            completeResult((await mocks.complete!(...args)) ?? undefined),
        }
      : {}),
    ...(mocks.stream ? { stream: mocks.stream } : {}),
  };
  return {
    ...actual,
    gateway,
    ...(mocks.resolveBinding ? { resolveBinding: mocks.resolveBinding } : {}),
    ...(mocks.resolveRequestBinding ? { resolveRequestBinding: mocks.resolveRequestBinding } : {}),
    ...(mocks.resolveHeaderBinding ? { resolveHeaderBinding: mocks.resolveHeaderBinding } : {}),
    ...(mocks.resolveParamsBinding ? { resolveParamsBinding: mocks.resolveParamsBinding } : {}),
  };
}

/** A plain binding-shaped object for routes that only read binding fields. */
export function fakeBinding(overrides: Partial<BindingFields> & Record<string, unknown> = {}) {
  const providerId = (overrides.providerId as string | undefined) ?? 'openai';
  const modelId = (overrides.modelId as string | undefined) ?? 'test-model';
  return {
    source: 'user',
    providerId,
    modelId,
    modelString: `${providerId}:${modelId}`,
    model: {
      id: modelId,
      name: modelId,
      api: 'openai-completions',
      provider: providerId,
      baseUrl: 'https://api.example.test/v1',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    },
    upstream: 'pi',
    capabilities: {
      tools: true,
      vision: false,
      reasoning: false,
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      knownModel: true,
    },
    transforms: { inlineThinkTags: false, payloadPatches: [] },
    funding: { kind: 'byok' },
    endpoint: 'official',
    credentialReady: true,
    fingerprint: 'test',
    ...overrides,
  };
}
