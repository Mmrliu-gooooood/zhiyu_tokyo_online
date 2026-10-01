/**
 * ZHIYU platform models → bindings (plan 3.9). `resolvePlatformDefault()`
 * stays the single authority (revision HMAC, enabled state, reviewed model
 * gate). The platform parameters win over the catalog: context / output
 * windows and the reviewed thinking capability.
 */
import type { ThinkingCapability } from '@/lib/types/provider';
import type { ResolvedPlatformDefault } from '@/lib/server/provider-config';
import { PLATFORM_DEFAULT_DEFINITIONS } from '@/lib/server/platform-default-models';
import type { TextPlatformDefaultId } from '../types';
import { buildModelSpec, type ModelSpec } from './model-spec';

/** Text platform ids, derived from the definitions (never hard-coded). */
export const TEXT_PLATFORM_DEFAULT_IDS: readonly TextPlatformDefaultId[] =
  PLATFORM_DEFAULT_DEFINITIONS.filter((entry) => entry.capability === 'text').map(
    (entry) => entry.defaultId as TextPlatformDefaultId,
  );

export function isTextPlatformDefaultId(value: string): value is TextPlatformDefaultId {
  return (TEXT_PLATFORM_DEFAULT_IDS as readonly string[]).includes(value);
}

function platformThinking(platform: ResolvedPlatformDefault): ThinkingCapability | undefined {
  const thinking = platform.parameters.textThinking;
  if (!thinking) return undefined;
  const toggleable = thinking.effortValues.includes('none');
  return {
    control: thinking.control,
    requestAdapter: thinking.requestAdapter,
    effortValues: [...thinking.effortValues],
    defaultEffort: thinking.defaultEffort,
    defaultMode: toggleable ? 'disabled' : 'enabled',
    toggleable,
    budgetAdjustable: true,
    defaultEnabled: !toggleable,
  };
}

/** The platform upstream model with the platform parameters applied. */
export async function platformModelSpec(platform: ResolvedPlatformDefault): Promise<ModelSpec> {
  const spec = await buildModelSpec({
    providerId: platform.providerId,
    modelId: platform.modelId,
    baseUrl: platform.baseUrl,
  });
  const parameters = platform.parameters;
  const contextWindow = parameters.textContextWindow ?? spec.model.contextWindow;
  const maxTokens = parameters.textOutputWindow ?? spec.model.maxTokens;
  const thinking = platformThinking(platform) ?? spec.capabilities.thinking;
  return {
    ...spec,
    model: {
      ...spec.model,
      contextWindow,
      maxTokens,
      reasoning: spec.model.reasoning || !!thinking,
    },
    capabilities: {
      ...spec.capabilities,
      tools: parameters.textTools ? true : spec.capabilities.tools,
      contextWindow,
      maxOutputTokens: maxTokens,
      knownModel: true,
      ...(thinking ? { thinking } : {}),
    },
  };
}
