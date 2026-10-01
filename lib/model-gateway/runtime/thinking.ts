/**
 * ThinkingConfig → pi request options (plan 3.7), the declarative payload
 * patches, and the output-token policy. The only place that knows how the
 * application's thinking semantics map onto pi's `reasoning` levels.
 *
 * Semantics are locked to the legacy stack by the P0-3 goldens:
 * - No config / `mode:'default'` without a level → the provider's own default:
 *   no thinking fields are sent at all (pi formats would otherwise send an
 *   explicit "off" or a default level).
 * - Models without a reviewed capability never get thinking fields.
 * - Effort / level / budget are picked with the same helpers the legacy
 *   adapters used, so non-toggleable models coerce "disabled" to their lowest
 *   effort and budget models use their catalog default budget.
 */
import {
  getThinkingMode,
  pickThinkingBudget,
  pickThinkingEffort,
  pickThinkingLevel,
} from '@/lib/ai/thinking-config';
import type {
  GatewayRequest,
  ModelBinding,
  PayloadPatchId,
  PiThinkingLevel,
  ThinkingCapability,
  ThinkingConfig,
} from '../types';

const PI_LEVELS: readonly PiThinkingLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
/** Levels pi accepts in `thinkingBudgets` (xhigh / max share the high budget). */
type BudgetLevel = 'minimal' | 'low' | 'medium' | 'high';

export type PayloadPatch = (payload: Record<string, unknown>) => void;

export interface ThinkingPlan {
  /** pi `reasoning`; undefined = off (or provider default when that patch is set). */
  reasoning?: PiThinkingLevel;
  thinkingBudgets?: Partial<Record<BudgetLevel, number>>;
  patches: PayloadPatchId[];
  /** The config the plan was derived from, after the global override. */
  effective?: ThinkingConfig;
}

function isPiLevel(value: unknown): value is PiThinkingLevel {
  return typeof value === 'string' && (PI_LEVELS as readonly string[]).includes(value);
}

/** `LLM_THINKING_DISABLED=true` applies only when the call has no explicit config. */
export function effectiveThinkingConfig(
  config: ThinkingConfig | undefined,
): ThinkingConfig | undefined {
  if (config) return config;
  return process.env.LLM_THINKING_DISABLED === 'true'
    ? { mode: 'disabled', enabled: false }
    : undefined;
}

/** Default level when thinking is on but no level was chosen. */
export function defaultThinkingLevel(capability?: ThinkingCapability): PiThinkingLevel {
  if (isPiLevel(capability?.defaultEffort)) return capability.defaultEffort;
  if (isPiLevel(capability?.defaultLevel)) return capability.defaultLevel;
  return 'medium';
}

function budgetLevel(level: PiThinkingLevel): BudgetLevel {
  return level === 'xhigh' || level === 'max' ? 'high' : level;
}

/** Claude models whose effort pi manages itself (it always sends `effort: high`). */
function isManagedEffortModel(model: ModelBinding['model']): boolean {
  return (
    model.api === 'anthropic-messages' &&
    (model.compat as { supportsMidConvoEffort?: boolean } | undefined)?.supportsMidConvoEffort ===
      true
  );
}

/** Anthropic effort value for a pi level (model map first, then the API's names). */
export function anthropicEffort(model: ModelBinding['model'], level: PiThinkingLevel): string {
  const mapped = model.thinkingLevelMap?.[level];
  if (typeof mapped === 'string') return mapped;
  return level === 'minimal' ? 'low' : level;
}

function hasExplicitIntent(config: ThinkingConfig): boolean {
  return (
    getThinkingMode(config) !== undefined ||
    config.effort !== undefined ||
    config.level !== undefined ||
    typeof config.budgetTokens === 'number'
  );
}

export function planThinking(
  binding: Pick<ModelBinding, 'thinking' | 'capabilities' | 'model'>,
): ThinkingPlan {
  const config = effectiveThinkingConfig(binding.thinking);
  const capability = binding.capabilities.thinking;
  const patches: PayloadPatchId[] = [];
  if (typeof config?.excludeReasoningOutput === 'boolean')
    patches.push('openrouter-exclude-reasoning');
  const providerDefault = (): ThinkingPlan => ({
    patches: [...patches, 'provider-default-thinking'],
    effective: config,
  });
  // Managed-effort models cannot be switched off through pi; omit thinking
  // entirely, as the legacy stack did.
  const off = (): ThinkingPlan =>
    managedEffort ? providerDefault() : { patches, effective: config };
  const managedEffort = isManagedEffortModel(binding.model);
  const on = (level: PiThinkingLevel, budget?: number): ThinkingPlan => {
    const hasBudget = budget !== undefined && budget > 0;
    return {
      reasoning: level,
      ...(hasBudget ? { thinkingBudgets: { [budgetLevel(level)]: budget } } : {}),
      patches: [
        ...patches,
        ...(hasBudget ? [] : (['omit-thinking-budget'] as const)),
        ...(managedEffort ? (['anthropic-managed-effort'] as const) : []),
      ],
      effective: config,
    };
  };

  if (!binding.model.reasoning || !capability?.control || capability.control === 'none') {
    return providerDefault();
  }
  if (!config || !hasExplicitIntent(config)) return providerDefault();

  const mode = getThinkingMode(config);
  switch (capability.control) {
    case 'effort': {
      const effort = pickThinkingEffort(capability, config);
      if (!effort) return providerDefault();
      if (effort === 'none') return off();
      return isPiLevel(effort) ? on(effort) : providerDefault();
    }
    case 'level': {
      const level = pickThinkingLevel(capability, config);
      return level ? on(level) : providerDefault();
    }
    case 'toggle-budget':
    case 'budget-only': {
      if (mode === 'disabled' && capability.toggleable !== false) return off();
      const budget = pickThinkingBudget(capability, config);
      return on(defaultThinkingLevel(capability), budget);
    }
    case 'toggle':
    case 'mode': {
      if (mode === 'auto')
        return { patches: [...patches, 'doubao-thinking-auto'], effective: config };
      if (mode === 'disabled') return off();
      if (mode === 'enabled') return on(defaultThinkingLevel(capability));
      return providerDefault();
    }
    default:
      return providerDefault();
  }
}

/** Output-token cap for the wire, plus whether the cap must be stripped. */
export function planMaxTokens(
  binding: Pick<ModelBinding, 'capabilities' | 'model'>,
  requested: GatewayRequest['maxOutputTokens'],
): { maxTokens?: number; omit: boolean } {
  if (typeof requested === 'number') return { maxTokens: requested, omit: false };
  const mode = requested ?? (binding.capabilities.knownModel ? 'model-default' : 'omit');
  if (mode === 'model-default') {
    return {
      maxTokens: binding.capabilities.maxOutputTokens ?? binding.model.maxTokens,
      omit: false,
    };
  }
  // Anthropic Messages requires max_tokens; keep the model's (descriptor) value.
  return { omit: binding.model.api !== 'anthropic-messages' };
}

/** Request fields that only carry thinking / reasoning controls. */
const THINKING_FIELDS = [
  'thinking',
  'reasoning_effort',
  'reasoning',
  'enable_thinking',
  'thinking_budget',
  'thinking_token_budget',
  'thinking_budget_tokens',
  'chat_template_kwargs',
] as const;

interface PatchContext {
  config: ThinkingConfig | undefined;
  level?: PiThinkingLevel;
  model?: ModelBinding['model'];
}

const PATCHES: Record<PayloadPatchId, (ctx: PatchContext) => PayloadPatch> = {
  'doubao-thinking-auto': () => (payload) => {
    payload.thinking = { type: 'auto' };
    delete payload.reasoning_effort;
  },
  'openrouter-exclude-reasoning':
    ({ config }) =>
    (payload) => {
      const reasoning =
        payload.reasoning && typeof payload.reasoning === 'object'
          ? (payload.reasoning as Record<string, unknown>)
          : {};
      payload.reasoning = { ...reasoning, exclude: config?.excludeReasoningOutput === true };
    },
  'omit-max-tokens': () => (payload) => {
    delete payload.max_tokens;
    delete payload.max_completion_tokens;
    delete payload.max_output_tokens;
  },
  'omit-thinking-budget': () => (payload) => {
    delete payload.thinking_budget;
    delete payload.thinking_token_budget;
    delete payload.thinking_budget_tokens;
  },
  'anthropic-managed-effort':
    ({ level, model }) =>
    (payload) => {
      if (!level || !model) return;
      const outputConfig =
        payload.output_config && typeof payload.output_config === 'object'
          ? (payload.output_config as Record<string, unknown>)
          : {};
      payload.output_config = { ...outputConfig, effort: anthropicEffort(model, level) };
    },
  'provider-default-thinking': () => (payload) => {
    for (const field of THINKING_FIELDS) {
      if (field === 'reasoning' && payload.reasoning && typeof payload.reasoning === 'object') {
        // Responses API: drop the effort but keep summary/encrypted-content plumbing.
        const { effort: _effort, ...rest } = payload.reasoning as Record<string, unknown>;
        if (Object.keys(rest).length > 0 && 'input' in payload) payload.reasoning = rest;
        else delete payload.reasoning;
        continue;
      }
      delete payload[field];
    }
    const outputConfig = payload.output_config as Record<string, unknown> | undefined;
    if (outputConfig && 'effort' in outputConfig) {
      const { effort: _effort, ...rest } = outputConfig;
      if (Object.keys(rest).length > 0) payload.output_config = rest;
      else delete payload.output_config;
    }
  },
};

/** Compose the binding's static patches with this call's dynamic ones. */
export function buildPayloadPatcher(
  ids: readonly PayloadPatchId[],
  ctx: PatchContext,
): ((payload: unknown) => unknown) | undefined {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return undefined;
  // Provider-default stripping runs first so explicit patches can still add fields.
  unique.sort(
    (a, b) => Number(b === 'provider-default-thinking') - Number(a === 'provider-default-thinking'),
  );
  const patches = unique.map((id) => PATCHES[id](ctx));
  return (payload) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
    const copy = { ...(payload as Record<string, unknown>) };
    for (const patch of patches) patch(copy);
    return copy;
  };
}
