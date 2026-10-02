import { resolveParamsBinding } from '@/lib/model-gateway';

/**
 * Resolve a model for an eval runner. Reads `process.env[envVar]`, falls back
 * to `fallback` if provided, and throws a clear error if neither is set.
 *
 * Never introduces a hardcoded default model string — evals must be explicit
 * about what they measure.
 */
export async function resolveEvalModel(envVar: string, fallback?: string) {
  const modelString = process.env[envVar] || fallback;
  if (!modelString) {
    throw new Error(
      `Eval model not configured: set ${envVar} in the environment (or pass an explicit fallback).`,
    );
  }
  const model = await resolveParamsBinding({ modelString });
  return {
    model,
    modelString: model.modelString,
    modelInfo: {
      outputWindow: model.capabilities.knownModel ? model.capabilities.maxOutputTokens : undefined,
      contextWindow: model.capabilities.contextWindow,
    },
  };
}
