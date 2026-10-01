/**
 * UI thinking capability for a model (plan 3.2): the reviewed overlay wins;
 * otherwise it is derived from pi's catalog data (`reasoning` + the
 * `thinkingLevelMap`). Isomorphic; no pi runtime import.
 */
import type { ThinkingCapability, ThinkingEffort } from '@/lib/types/provider';
import { EXTRA_THINKING_CAPABILITIES, REVIEWED_MODELS } from './reviewed-models';
import { getCanonicalModelId } from '@/lib/ai/model-aliases';

/** pi levels in order; xhigh / max are opt-in in pi (absent = unsupported). */
const BASE_LEVELS = ['minimal', 'low', 'medium', 'high'] as const;
const OPT_IN_LEVELS = ['xhigh', 'max'] as const;

export interface PiThinkingData {
  reasoning: boolean;
  thinkingLevelMap?: Partial<Record<string, string | null>>;
}

/** Reviewed capability of a legacy-catalog model, by app provider id and model id. */
export function reviewedThinkingCapability(
  providerId: string,
  modelId: string,
): ThinkingCapability | undefined {
  const canonical = getCanonicalModelId(providerId, modelId);
  const listed = REVIEWED_MODELS[providerId]?.find((model) => model.id === canonical);
  if (listed) return listed.capabilities?.thinking;
  const extra = EXTRA_THINKING_CAPABILITIES[`${providerId}:${canonical}`];
  if (extra) return extra;
  // Lemonade serves arbitrary local GGUF models with one chat template.
  if (providerId === 'lemonade') return EXTRA_THINKING_CAPABILITIES['lemonade:gpt-oss-20b'];
  return undefined;
}

/** Effort capability derived from pi catalog data (new providers). */
export function deriveThinkingCapability(model: PiThinkingData): ThinkingCapability | undefined {
  if (!model.reasoning) return undefined;
  const map = model.thinkingLevelMap ?? {};
  const supported: ThinkingEffort[] = [
    ...BASE_LEVELS.filter((level) => map[level] !== null),
    ...OPT_IN_LEVELS.filter((level) => typeof map[level] === 'string'),
  ];
  if (supported.length === 0) return undefined;
  const canDisable = map.off !== null;
  const defaultEffort: ThinkingEffort = supported.includes('medium')
    ? 'medium'
    : supported[supported.length - 1]!;
  return {
    control: 'effort',
    effortValues: canDisable ? ['none', ...supported] : supported,
    defaultEffort,
    defaultMode: 'enabled',
    toggleable: canDisable,
    budgetAdjustable: supported.length > 1,
    defaultEnabled: true,
  };
}
