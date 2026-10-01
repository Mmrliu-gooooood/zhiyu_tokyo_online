/**
 * Test gateway backed by pi's faux provider. Business tests use it instead of
 * `vi.mock('@/lib/ai/llm')`: responses are scripted pi assistant messages
 * (text, thinking, tool calls, errors) and the real gateway pipeline runs,
 * with usage, logs and quota captured in memory.
 */
import {
  fauxProvider,
  type FauxModelDefinition,
  type FauxProviderHandle,
  type FauxResponseStep,
} from '@earendil-works/pi-ai';
import { createBinding, type BindingFields } from '../credentials/handles';
import { sealedAuthContext } from '../credentials/auth-context';
import { createGateway, type GatewayDeps, type LlmCallLog } from '../runtime/pipeline';
import type { UsageEvent } from '../runtime/usage';
import type { QuotaLease } from '../runtime/quota';
import type { ModelBinding, ModelGateway } from '../types';

// Direct re-export: esbuild elides imported bindings that are only re-exported.
export { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from '@earendil-works/pi-ai';
export type { FauxResponseStep };

export interface FauxGatewayOptions {
  model?: FauxModelDefinition;
  /** Script of responses consumed one per upstream call. */
  responses?: FauxResponseStep[];
  /** Simulate a background deployment quota (counts acquire/release). */
  quota?: boolean;
  deps?: Partial<GatewayDeps>;
  /** Stream speed; defaults to effectively instant. */
  tokensPerSecond?: number;
}

export interface FauxQuotaStats {
  acquired: number;
  released: number;
  releaseErrors: unknown[];
}

export interface FauxGateway {
  gateway: ModelGateway;
  faux: FauxProviderHandle;
  /** A binding to the faux model; override any non-credential field. */
  binding(overrides?: Partial<BindingFields>): ModelBinding;
  calls: LlmCallLog[];
  usage: UsageEvent[];
  quota: FauxQuotaStats;
}

let sequence = 0;

export function createFauxGateway(options: FauxGatewayOptions = {}): FauxGateway {
  sequence += 1;
  const providerId = `faux-gateway-${sequence}`;
  const faux = fauxProvider({
    provider: providerId,
    api: `faux-api-${sequence}`,
    models: [options.model ?? { id: 'faux-model', reasoning: true, input: ['text', 'image'] }],
    tokensPerSecond: options.tokensPerSecond ?? 1_000_000,
  });
  if (options.responses) faux.setResponses(options.responses);

  const calls: LlmCallLog[] = [];
  const usage: UsageEvent[] = [];
  const quota: FauxQuotaStats = { acquired: 0, released: 0, releaseErrors: [] };

  const gateway = createGateway({
    resolveProvider: async () => ({ provider: faux.provider, authContext: sealedAuthContext() }),
    recordUsage: (event) => usage.push(event),
    logCall: (line) => calls.push(line),
    sleep: async () => undefined,
    quota: options.quota
      ? async (): Promise<QuotaLease> => {
          quota.acquired += 1;
          let released = false;
          return {
            signal: new AbortController().signal,
            release: async (error) => {
              if (released) return;
              released = true;
              quota.released += 1;
              if (error !== undefined) quota.releaseErrors.push(error);
            },
          };
        }
      : async () => undefined,
    ...options.deps,
  });

  const model = faux.getModel();
  return {
    gateway,
    faux,
    calls,
    usage,
    quota,
    binding(overrides = {}) {
      return createBinding(
        {
          source: 'user',
          providerId: 'faux',
          modelId: model.id,
          modelString: `faux:${model.id}`,
          model,
          upstream: 'pi',
          capabilities: {
            tools: true,
            vision: model.input.includes('image'),
            reasoning: model.reasoning,
            contextWindow: model.contextWindow,
            maxOutputTokens: model.maxTokens,
            knownModel: true,
          },
          transforms: { inlineThinkTags: false, payloadPatches: [] },
          funding: { kind: 'byok' },
          endpoint: 'official',
          ...overrides,
        },
        { kind: 'inline-key', apiKey: 'faux-key' },
      );
    },
  };
}
