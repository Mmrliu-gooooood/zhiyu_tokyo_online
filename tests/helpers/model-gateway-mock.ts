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
 * Or pass `delegate: () => faux.gateway` to run the real pipeline against
 * lib/model-gateway/testing/faux-gateway.ts.
 *
 * `complete` mocks may resolve to a partial result (`{ text }`); the rest of
 * the GatewayResult is filled in.
 */
import type * as GatewayModule from '@/lib/model-gateway';
import type { BindingFields } from '@/lib/model-gateway';
import type { Mock } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- vi.fn() / functions of any signature
type AnyMock = Mock<(...args: any[]) => any> | ((...args: any[]) => any);

export interface GatewayModuleMocks {
  complete?: AnyMock;
  stream?: AnyMock;
  resolveBinding?: AnyMock;
  resolveRequestBinding?: AnyMock;
  resolveHeaderBinding?: AnyMock;
  resolveParamsBinding?: AnyMock;
  /** Route `gateway` calls to another instance (e.g. createFauxGateway().gateway). */
  delegate?: () => GatewayModule.ModelGateway;
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
  const delegate = mocks.delegate;
  const gateway = {
    ...actual.gateway,
    ...(delegate
      ? {
          stream: (...args: Parameters<GatewayModule.ModelGateway['stream']>) =>
            delegate().stream(...args),
          complete: (...args: Parameters<GatewayModule.ModelGateway['complete']>) =>
            delegate().complete(...args),
        }
      : {}),
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

/**
 * A gateway stream from text chunks (the shape AI SDK tests scripted as
 * `{ textStream }`): one `text_delta` per chunk, then `done`.
 */
export function fromTextStream({ textStream }: { textStream: AsyncIterable<string> }) {
  async function* events() {
    let text = '';
    for await (const delta of textStream) {
      text += delta;
      yield { type: 'text_delta' as const, contentIndex: 0, delta };
    }
    yield { type: 'done' as const, reason: 'stop' as const, message: { role: 'assistant', text } };
  }
  return {
    [Symbol.asyncIterator]: events,
    async *textStream() {
      yield* textStream;
    },
    result: async () => completeResult(),
  };
}
