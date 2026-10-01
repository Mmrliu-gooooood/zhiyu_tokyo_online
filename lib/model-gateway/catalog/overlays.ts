/**
 * Reviewed per-model wire hints that pi's catalog does not carry (plan 3.2):
 * protocol selection, compat corrections and request-shape capabilities for
 * models served through a provider slot they do not natively belong to.
 * Display data (names, windows, thinking UI) lives in reviewed-models.ts.
 */
import type { ThinkingCapability } from '@/lib/types/provider';
import type { WireApi } from '../types';

export interface ModelHint {
  api?: WireApi;
  compat?: Readonly<Record<string, unknown>>;
  /** Request-shape capability when the model has no reviewed UI capability. */
  thinking?: ThinkingCapability;
}

/** Keyed by `provider:model` (application ids). */
export const MODEL_HINTS: Readonly<Record<string, ModelHint>> = {
  // Served through an OpenAI-compatible vLLM gateway in the `openai` slot: its
  // chat template takes `chat_template_kwargs.thinking`, not reasoning_effort.
  'openai:deepseek-v4-flash-vision-exp': {
    api: 'openai-completions',
    compat: {
      thinkingFormat: 'chat-template',
      chatTemplateKwargs: { thinking: { $var: 'thinking.enabled' } },
      supportsReasoningEffort: false,
      supportsDeveloperRole: false,
      supportsStore: false,
    },
    thinking: {
      control: 'toggle',
      requestAdapter: 'none',
      toggleable: true,
      budgetAdjustable: false,
    },
  },
};

export function modelHint(providerId: string, modelId: string): ModelHint | undefined {
  return MODEL_HINTS[`${providerId}:${modelId}`];
}

/**
 * OpenAI wire protocol by model (legacy rule, RQ-02/RQ-03): GPT-5.5 / 5.6,
 * the pro and codex families use the Responses API; everything else Chat.
 */
export function openaiDefaultApi(modelId: string): WireApi {
  return /^gpt-5\.\d+-pro(?:-|$)/.test(modelId) ||
    /^gpt-5\.6(?:-|$)/.test(modelId) ||
    /^gpt-5\.5(?:-|$)/.test(modelId) ||
    /^gpt-5\.[3-9]-codex(?:-|$)/.test(modelId)
    ? 'openai-responses'
    : 'openai-completions';
}
