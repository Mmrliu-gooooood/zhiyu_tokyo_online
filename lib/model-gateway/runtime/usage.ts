/**
 * pi usage → the application's NormalizedUsage, keeping the existing semantics
 * (plan 3.9): `inputTokens` includes cached input (the AI SDK convention the
 * usage tables were built on), pi's `input` excludes it. Cache tokens are never
 * double counted.
 */
import type { NormalizedUsage, PiUsage } from '../types';

function count(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export function toNormalizedUsage(usage: PiUsage | undefined): NormalizedUsage {
  if (!usage) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
    };
  }
  const cacheRead = count(usage.cacheRead);
  const cacheWrite = count(usage.cacheWrite);
  return {
    inputTokens: count(usage.input) + cacheRead + cacheWrite,
    outputTokens: count(usage.output),
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheWrite,
    reasoningTokens: count(usage.reasoning),
  };
}

export function addUsage(a: NormalizedUsage, b: NormalizedUsage): NormalizedUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

export const ZERO_USAGE: NormalizedUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  reasoningTokens: 0,
});

export interface UsageEvent {
  source: string;
  providerId: string;
  modelId: string;
  modelString: string;
  usage: NormalizedUsage;
  jobId?: string;
  sessionId?: string;
  requestId?: string;
  eventKey?: string;
}

export type UsageRecorder = (event: UsageEvent) => void;

/** Default recorder: fire-and-forget into usage storage; failures never affect generation. */
export const recordUsageEvent: UsageRecorder = (event) => {
  void (async () => {
    try {
      const { recordUsage } = await import('@/lib/server/usage-storage');
      await recordUsage({ kind: 'llm', ...event });
    } catch (error) {
      const { createLogger } = await import('@/lib/logger');
      createLogger('ModelGateway').warn('Usage capture failed (ignored):', error);
    }
  })();
};
