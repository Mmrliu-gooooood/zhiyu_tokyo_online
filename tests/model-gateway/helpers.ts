import {
  createBinding,
  type BindingFields,
  type CredentialHandle,
} from '@/lib/model-gateway/credentials/handles';
import { loadPiProvider } from '@/lib/model-gateway/runtime/pi-registry';
import {
  createGateway,
  type GatewayDeps,
  type LlmCallLog,
} from '@/lib/model-gateway/runtime/pipeline';
import type { UsageEvent } from '@/lib/model-gateway/runtime/usage';
import type { ModelBinding, PiModel } from '@/lib/model-gateway/types';

/** Path suffix pi's SDK client appends after `baseUrl` differs per provider. */
const BASE_PATH: Record<string, string> = { openai: '/v1', anthropic: '', deepseek: '' };

export async function piModel(piProviderId: string, modelId: string): Promise<PiModel> {
  const provider = await loadPiProvider(piProviderId);
  const model = provider.getModels().find((entry) => entry.id === modelId);
  if (!model) throw new Error(`pi catalog has no ${piProviderId}/${modelId}`);
  return model;
}

export async function bindingFor(
  piProviderId: string,
  modelId: string,
  origin: string,
  overrides: Partial<BindingFields> = {},
  handle: CredentialHandle = { kind: 'inline-key', apiKey: 'sk-request-key' },
): Promise<ModelBinding> {
  const model = await piModel(piProviderId, modelId);
  return createBinding(
    {
      source: 'user',
      providerId: piProviderId,
      modelId,
      modelString: `${piProviderId}:${modelId}`,
      model: { ...model, baseUrl: `${origin}${BASE_PATH[piProviderId] ?? ''}` },
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
    handle,
  );
}

export interface TestGateway {
  gateway: ReturnType<typeof createGateway>;
  calls: LlmCallLog[];
  usage: UsageEvent[];
  sleeps: number[];
}

export function testGateway(overrides: Partial<GatewayDeps> = {}): TestGateway {
  const calls: LlmCallLog[] = [];
  const usage: UsageEvent[] = [];
  const sleeps: number[] = [];
  const gateway = createGateway({
    recordUsage: (event) => usage.push(event),
    logCall: (line) => calls.push(line),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    quota: async () => undefined,
    ...overrides,
  });
  return { gateway, calls, usage, sleeps };
}
