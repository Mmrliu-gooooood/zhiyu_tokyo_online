import type { AICallFn } from '@openmaic/generation';

import { gateway, resolveBinding, userText, type ModelBinding } from '@/lib/model-gateway';
import type { LlmStage } from '@/lib/server/model-routes';
import type { ProModelContext } from '@/types/pro-model';
import { safeModelError } from './model-errors';

const CONTENT_TYPES = new Set(['slide', 'quiz', 'interactive', 'pbl']);

export function sceneContentStage(type?: string): LlmStage {
  return type && CONTENT_TYPES.has(type) ? (`scene-content:${type}` as LlmStage) : 'scene-content';
}

/** Bind the generation package's neutral callback seam to server stage routing. */
export function createGenerationAiCallFactory(options?: {
  abortSignal?: AbortSignal;
  modelContext?: ProModelContext;
}): (stage: LlmStage) => AICallFn {
  const calls = new Map<LlmStage, AICallFn>();
  return (stage) => {
    const cached = calls.get(stage);
    if (cached) return cached;
    let binding: ModelBinding | undefined;
    const call: AICallFn = async (systemPrompt, userPrompt) => {
      try {
        options?.abortSignal?.throwIfAborted();
        await options?.modelContext?.assertActive?.();
        // A configured stage route ignores the connection context (resolveBinding).
        binding ??= await resolveBinding({ selection: options?.modelContext?.selection, stage });
        const result = await gateway.complete(
          binding,
          { system: systemPrompt, messages: [userText(userPrompt)] },
          { source: stage, signal: options?.abortSignal, retry: 'none' },
        );
        return result.text;
      } catch (error) {
        throw new Error(safeModelError(error));
      }
    };
    calls.set(stage, call);
    return call;
  };
}
