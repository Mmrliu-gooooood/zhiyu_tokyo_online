import {
  createBinding,
  getCredentialHandle,
  type BindingFields,
  type CredentialHandle,
} from '@/lib/model-gateway/credentials/handles';
import { FETCHLESS_APIS } from '@/lib/model-gateway/runtime/fetchless';
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

/**
 * Point a binding at the fake server, keeping its path and remembering the
 * real host. Fetch-less SDK transports may only reach official / operator
 * endpoints, so the fake server stands in for an operator-configured one.
 */
export function rerouteBinding(
  binding: ModelBinding,
  origin: string,
): { binding: ModelBinding; host: string } {
  const real = new URL(binding.model.baseUrl);
  const { fingerprint: _f, credentialReady: _r, ...fields } = binding;
  const pathname = real.pathname.replace(/\/+$/, '');
  // The AWS SDK speaks HTTP/2 by default; the fake server is HTTP/1.1.
  const requestEnv =
    binding.model.api === 'bedrock-converse-stream'
      ? { ...binding.requestEnv, AWS_BEDROCK_FORCE_HTTP1: '1' }
      : binding.requestEnv;
  return {
    host: real.host,
    binding: createBinding(
      {
        ...fields,
        model: { ...binding.model, baseUrl: `${origin}${pathname}` },
        ...(FETCHLESS_APIS.has(binding.model.api) ? { endpoint: 'operator' as const } : {}),
        ...(requestEnv ? { requestEnv } : {}),
      },
      getCredentialHandle(binding),
    ),
  };
}
