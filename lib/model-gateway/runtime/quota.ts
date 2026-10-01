/**
 * Background-deployment provider quota (replaces the model-quota Proxy).
 * A slot is acquired before the upstream call and held until the stream
 * terminates (done, error, abort or consumer cancellation), then released.
 */
import { isHostedAuthEnabled } from '@/lib/auth/mode';
import {
  generationQuotaActive,
  getProviderQuotaOwner,
} from '@/lib/server/generation-jobs/provider-call-context';

export interface QuotaLease {
  /** Aborts if the limiter loses the slot (lease expiry / database loss). */
  readonly signal: AbortSignal;
  /** Release the slot; an error with statusCode 429 triggers the limiter cooldown. */
  release(error?: unknown): Promise<void>;
}

export interface QuotaLimiter {
  run<T>(kind: 'llm', group: string, signal: AbortSignal, work: () => Promise<T>): Promise<T>;
}

export type QuotaAcquirer = (signal: AbortSignal) => Promise<QuotaLease | undefined>;

/** Wait for a slot from `limiter`; the returned lease keeps it until released. */
export function leaseFrom(limiter: QuotaLimiter, signal: AbortSignal): Promise<QuotaLease> {
  return new Promise<QuotaLease>((resolveLease, rejectLease) => {
    const lost = new AbortController();
    let released = false;
    let settle: ((error?: unknown) => void) | undefined;
    const done = limiter.run(
      'llm',
      'deployment',
      signal,
      () =>
        new Promise<void>((resolve, reject) => {
          settle = (error) => (error === undefined ? resolve() : reject(error));
          resolveLease({
            signal: lost.signal,
            release: async (error) => {
              if (released) return;
              released = true;
              settle?.(error);
              await done.catch(() => undefined);
            },
          });
        }),
    );
    done.catch((error: unknown) => {
      if (!settle) rejectLease(error);
      else if (!released) lost.abort(error);
    });
  });
}

/** Default acquirer: only in background deployments, and not when a job already holds quota. */
export const acquireDeploymentQuota: QuotaAcquirer = async (signal) => {
  if (process.env.GENERATION_BACKGROUND_ENABLED !== '1' || generationQuotaActive())
    return undefined;
  // The browser-driven deployment must not load the PostgreSQL queue graph.
  const [{ PostgresGenerationLimiter }, { generationConfig }, { getGenerationRequestPool }] =
    await Promise.all([
      import('@/lib/server/generation-jobs/limiter'),
      import('@/lib/server/generation-jobs/config'),
      import('@/lib/server/generation-jobs/runtime'),
    ]);
  signal.throwIfAborted();
  const config = generationConfig();
  const limiter = new PostgresGenerationLimiter(
    getGenerationRequestPool(),
    { llm: config.llmConcurrency, tts: config.ttsConcurrency, media: config.mediaConcurrency },
    { ownerId: isHostedAuthEnabled() ? getProviderQuotaOwner() : undefined },
  );
  return leaseFrom(limiter, signal);
};
