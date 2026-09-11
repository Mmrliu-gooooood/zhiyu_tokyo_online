import type { Api, Model } from '@earendil-works/pi-ai';

import { getStageRoute } from '@/lib/server/model-routes';
import { resolveModel, type ResolvedModel } from '@/lib/server/resolve-model';
import { getProvider } from '@/lib/ai/providers';
import type { ProviderId } from '@/lib/types/provider';
import type { ProModelContext } from '@/types/pro-model';

export const AGENT_DRIVER_STAGE = 'maic-agent-driver' as const;
export const UNKNOWN_MODEL_RESERVED_OUTPUT_TOKENS = 8_192;
// The driver route owns the model choice. This adapter only enforces its transport
// contract: a resolvable provider prefix, no thinking effort, and an explicit
// OpenAI-compatible pi api/dialect. The actual HTTP transport is selected by
// lib/ai/providers.ts.
const OPENAI_PI_APIS = new Set<Api>(['openai-completions', 'openai-responses']);

export function buildPiDriverModel(
  connection: ResolvedModel,
  configuredApi?: string,
  routeContextWindow?: number,
): Model<Api> {
  if (!configuredApi || !OPENAI_PI_APIS.has(configuredApi)) {
    throw new Error(
      `MODEL_ROUTES stage "${AGENT_DRIVER_STAGE}" has unsupported pi api/dialect ` +
        `${JSON.stringify(configuredApi)} for model id ${connection.modelId}.`,
    );
  }
  return {
    id: connection.modelId,
    name: connection.modelId,
    api: configuredApi,
    provider: connection.providerId,
    baseUrl: connection.baseUrl ?? '',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // Context-window value chain: route operator pin > catalog model window >
    // conservative 128k fallback. The fallback is only an internal estimate
    // used to decide when to compact; it is not sent to the model API. It must
    // stay below the gateway's real request limit so compaction remains
    // reachable before the gateway rejects an oversized prompt.
    contextWindow: routeContextWindow ?? connection.modelInfo?.contextWindow ?? 128_000,
    // Pi requires Model.maxTokens. For known models this is the real catalog
    // output window. For unknown models 8192 is only a deterministic internal
    // compaction reservation; resolveAgentDriverModel deliberately exposes an
    // independent undefined wireMaxOutputTokens so it never becomes an API cap.
    maxTokens: connection.modelInfo?.outputWindow ?? UNKNOWN_MODEL_RESERVED_OUTPUT_TOKENS,
  } as Model<Api>;
}

/** Dedicated route wins; otherwise use the run's bound Home connection. */
export async function resolveAgentDriverModel(modelContext?: ProModelContext): Promise<{
  connection: ResolvedModel;
  piModel: Model<Api>;
  /** Catalog-backed API limit; undefined means omit max_tokens on the wire. */
  wireMaxOutputTokens?: number;
  /** Internal compaction output-space estimate; never used as a conversation API limit. */
  reservedOutputTokens: number;
}> {
  const route = getStageRoute(AGENT_DRIVER_STAGE);
  await modelContext?.assertActive?.();
  if (!route && !modelContext) {
    throw new Error(
      `MODEL_ROUTES must explicitly configure stage "${AGENT_DRIVER_STAGE}" ` +
        `with a provider-prefixed model id and an api/dialect.`,
    );
  }
  // The provider prefix must be explicit. parseModelString silently defaults a
  // bare model id to the openai provider, so the driver must fail here before
  // resolveModel reaches that fallback and routes to the wrong provider.
  const modelString =
    route?.model ??
    modelContext?.modelString ??
    (modelContext?.source === 'platform' && modelContext.defaultId
      ? `platform:${modelContext.defaultId}`
      : undefined);
  if (!modelString) {
    throw new Error('PRO_MODEL_CONFIGURATION_REQUIRED: No model selection is available.');
  }
  const providerSeparator = modelString.indexOf(':');
  const modelId = providerSeparator > 0 ? modelString.slice(providerSeparator + 1) : undefined;
  if (!modelId) {
    throw new Error(
      `MODEL_ROUTES stage "${AGENT_DRIVER_STAGE}" must use a model id with an explicit ` +
        `provider prefix; ` +
        `received an invalid model identifier.`,
    );
  }
  if (route?.thinking?.effort !== undefined) {
    throw new Error(
      `MODEL_ROUTES stage "${AGENT_DRIVER_STAGE}" must not set thinking.effort because ` +
        `${modelId} cannot combine reasoning_effort with function tools on this transport.`,
    );
  }
  // Never forward personal credentials when an administrator selected this stage.
  const connection = await resolveModel(
    route ? { stage: AGENT_DRIVER_STAGE } : { ...modelContext, stage: AGENT_DRIVER_STAGE },
  );
  let api = route?.api ?? modelContext?.api;
  if (!route) {
    const provider = getProvider(connection.providerId as ProviderId);
    if (!api && provider?.type === 'openai') {
      api =
        typeof connection.model !== 'string' && connection.model?.provider?.endsWith('.responses')
          ? 'openai-responses'
          : 'openai-completions';
    }
    // Home's existing custom-provider OpenAI mode explicitly uses chat
    // completions in getModel; this is a saved transport choice, not a probe.
    if (!api && !provider && modelContext?.providerType === 'openai') api = 'openai-completions';
    if (!api) throw new Error('PRO_MODEL_PROTOCOL: 请在模型设置中选择支持的 OpenAI 协议。');
    const providerType = provider?.type ?? modelContext?.providerType;
    if (providerType && providerType !== 'openai') {
      throw new Error('PRO_MODEL_PROTOCOL: 当前 PRO 驱动仅支持 OpenAI 兼容协议，请更换模型连接。');
    }
    // Home effort is a generation preference; this tool driver cannot send it.
    if (connection.thinkingConfig) {
      const { effort: _effort, ...thinking } = connection.thinkingConfig;
      // The driver transport cannot combine an effort parameter with tools,
      // but its explicit on/off preference is still meaningful. Removing one
      // unsupported field must not silently restore provider-default thinking.
      connection.thinkingConfig = thinking;
    }
  }
  if (connection.modelInfo?.capabilities?.tools === false) {
    throw new Error('PRO_MODEL_TOOLS: 当前模型已确认不支持工具调用，请在模型设置中更换模型。');
  }
  const wireMaxOutputTokens = connection.modelInfo?.outputWindow;
  return {
    connection,
    piModel: buildPiDriverModel(connection, api, route?.contextWindow),
    wireMaxOutputTokens,
    reservedOutputTokens: wireMaxOutputTokens ?? UNKNOWN_MODEL_RESERVED_OUTPUT_TOKENS,
  };
}
