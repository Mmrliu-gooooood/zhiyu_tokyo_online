import type { AgentLlmModel } from '@/lib/model-gateway/adapters/agent-pi-types';

import {
  resolveBinding,
  selectionModelString,
  withThinking,
  type ModelBinding,
} from '@/lib/model-gateway';
import { getStageRoute } from '@/lib/server/model-routes';
import type { ProModelContext } from '@/types/pro-model';

export const AGENT_DRIVER_STAGE = 'maic-agent-driver' as const;
export const UNKNOWN_MODEL_RESERVED_OUTPUT_TOKENS = 8_192;

/**
 * The agent kernel's model description for a resolved binding. The pi ids
 * (api / provider / id) match the messages the gateway produces, so replayed
 * turns are recognised as the same model. `contextWindow` and `maxTokens` are
 * only the kernel's internal compaction estimates, never wire limits.
 */
export function buildPiDriverModel(
  binding: ModelBinding,
  routeContextWindow?: number,
): AgentLlmModel {
  const { model, capabilities } = binding;
  return {
    id: model.id,
    name: model.name,
    api: model.api,
    provider: model.provider,
    baseUrl: model.baseUrl,
    reasoning: capabilities.reasoning,
    input: capabilities.vision ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // Context-window value chain: route operator pin > catalog window >
    // conservative 128k fallback. It must stay below the provider's real
    // request limit so compaction remains reachable before a rejection.
    contextWindow:
      routeContextWindow ?? (capabilities.knownModel ? capabilities.contextWindow : 128_000),
    // For unknown models 8192 is only a deterministic compaction reservation;
    // resolveAgentDriverModel exposes an undefined wireMaxOutputTokens so it
    // never becomes an API cap.
    maxTokens: driverWireMaxOutputTokens(binding) ?? UNKNOWN_MODEL_RESERVED_OUTPUT_TOKENS,
  } as AgentLlmModel;
}

function driverWireMaxOutputTokens(binding: ModelBinding): number | undefined {
  return binding.capabilities.knownModel ? binding.capabilities.maxOutputTokens : undefined;
}

/**
 * Dedicated route wins; otherwise use the run's bound Home connection.
 * After-class classmate chats (B05) resolve through their own stage so an
 * operator route for the Pro driver does not silently replace them.
 */
export async function resolveAgentDriverModel(
  modelContext?: ProModelContext,
  stage: typeof AGENT_DRIVER_STAGE | 'study-companion' = AGENT_DRIVER_STAGE,
): Promise<{
  binding: ModelBinding;
  piModel: AgentLlmModel;
  /** Catalog-backed API limit; undefined means omit the output cap on the wire. */
  wireMaxOutputTokens?: number;
  /** Internal compaction output-space estimate; never used as a conversation API limit. */
  reservedOutputTokens: number;
}> {
  const route = getStageRoute(stage);
  await modelContext?.assertActive?.();
  if (!route && !modelContext) {
    throw new Error(
      `MODEL_ROUTES must explicitly configure stage "${stage}" ` +
        `with a provider-prefixed model id.`,
    );
  }
  // The provider prefix must be explicit. A bare model id would silently
  // default to the openai provider, so the driver fails here instead.
  const modelString =
    route?.model ?? (modelContext ? selectionModelString(modelContext.selection) : undefined);
  if (!modelString) {
    throw new Error('PRO_MODEL_CONFIGURATION_REQUIRED: No model selection is available.');
  }
  const providerSeparator = modelString.indexOf(':');
  const modelId = providerSeparator > 0 ? modelString.slice(providerSeparator + 1) : undefined;
  if (!modelId) {
    throw new Error(
      `MODEL_ROUTES stage "${stage}" must use a model id with an explicit ` +
        `provider prefix; received an invalid model identifier.`,
    );
  }
  // A configured route ignores the Home connection entirely (resolveBinding),
  // so personal credentials never reach an administrator-selected model.
  let binding = await resolveBinding({
    selection: modelContext?.selection,
    stage,
  });
  if (binding.capabilities.tools === false) {
    throw new Error('PRO_MODEL_TOOLS: 当前模型已确认不支持工具调用，请在模型设置中更换模型。');
  }
  // Only models reviewed as rejecting a reasoning effort alongside function
  // tools lose the effort; their explicit on/off preference is kept.
  if (binding.capabilities.rejectsReasoningWithTools && binding.thinking?.effort !== undefined) {
    if (route) {
      throw new Error(
        `MODEL_ROUTES stage "${stage}" must not set thinking.effort because ` +
          `${modelId} cannot combine a reasoning effort with function tools.`,
      );
    }
    const { effort: _effort, ...thinking } = binding.thinking;
    binding = withThinking(binding, thinking);
  }
  const wireMaxOutputTokens = driverWireMaxOutputTokens(binding);
  return {
    binding,
    piModel: buildPiDriverModel(binding, route?.contextWindow),
    wireMaxOutputTokens,
    reservedOutputTokens: wireMaxOutputTokens ?? UNKNOWN_MODEL_RESERVED_OUTPUT_TOKENS,
  };
}
