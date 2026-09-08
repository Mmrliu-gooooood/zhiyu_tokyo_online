import { canonicalHash } from '@/lib/server/generation-jobs/contracts';
import type {
  GenerationLease,
  StepReceipt,
  StepStart,
} from '@/lib/server/generation-jobs/contracts';
import { runWithGenerationQuota } from '@/lib/server/generation-jobs/provider-call-context';
import { assertGenerationConfigSnapshot } from '@/lib/server/generation-jobs/config-snapshot';
import { ConfirmedMediaFailure } from '@/lib/media/generation-errors';
import { withPolledTaskPersistence } from '@/lib/media/polled-task';

export interface CheckpointRepository {
  skipStepWithWarning(
    lease: GenerationLease,
    input: { stepKey: string; code: string },
  ): Promise<void>;
  beginStep(lease: GenerationLease, step: StepStart): Promise<StepReceipt>;
  commitCheckpoint(
    lease: GenerationLease,
    checkpoint: {
      stepKey: string;
      result: unknown;
      outlineId?: string;
      sceneStatus?: string;
      content?: unknown;
      actions?: unknown;
      previousSpeechesHash?: string;
    },
  ): Promise<unknown>;
  failStep(
    lease: GenerationLease,
    failure: {
      stepKey: string;
      code: string;
      uncertain: boolean;
      retryable?: boolean;
      retryAfterMs?: number;
    },
  ): Promise<unknown>;
  recordProviderRequest?(
    lease: GenerationLease,
    input: { attemptId: string; taskId: string },
  ): Promise<void>;
}

/** An outbound request may have been accepted. Never automatically replay it. */
export class UnknownExternalOutcome extends Error {
  constructor(readonly stepKey: string) {
    super('EXTERNAL_RESULT_UNKNOWN');
  }
}
export class ProviderRetryScheduled extends Error {
  readonly safeToRetry = true;
  constructor() {
    super('PROVIDER_RATE_LIMITED');
  }
}

export type QuotaKind = 'llm' | 'tts' | 'media';
export const EXTERNAL_CALL_DEADLINES_MS: Readonly<Record<QuotaKind, number>> = {
  llm: 300_000,
  tts: 120_000,
  media: 600_000,
};
export interface QuotaGate {
  run<T>(kind: QuotaKind, group: string, signal: AbortSignal, work: () => Promise<T>): Promise<T>;
  cooldown?(group: string, retryAfterMs: number): Promise<void>;
}

export class PipelineExecution {
  private readonly stopped = new AbortController();
  readonly signal: AbortSignal;
  constructor(
    readonly repository: CheckpointRepository,
    readonly lease: GenerationLease,
    signal: AbortSignal,
    readonly quota: QuotaGate,
  ) {
    this.signal = AbortSignal.any([signal, this.stopped.signal]);
  }

  async checkpoint<T>(
    key: string,
    dependency: unknown,
    work: () => Promise<T>,
    kind = key,
  ): Promise<T> {
    this.signal.throwIfAborted();
    const receipt = await this.repository.beginStep(this.lease, {
      key,
      kind,
      dependencyHash: canonicalHash(dependency),
      external: false,
      outlineId: sceneOutlineId(key),
    });
    if (receipt.status === 'succeeded') return receipt.result as T;
    try {
      const result = await work();
      this.signal.throwIfAborted();
      const outlineId = sceneOutlineId(key);
      await this.repository.commitCheckpoint(this.lease, {
        stepKey: key,
        result,
        outlineId,
        ...(key.startsWith('content:') && key.split(':').length === 2
          ? { content: result, sceneStatus: 'content_ready' }
          : {}),
        ...(key.startsWith('actions:') && key.split(':').length === 2
          ? {
              actions: result,
              sceneStatus: 'actions_ready',
              previousSpeechesHash: canonicalHash(
                (dependency as { previousSpeeches?: string[] }).previousSpeeches ?? [],
              ),
            }
          : {}),
      });
      return result;
    } catch (error) {
      // A nested provider receipt already records uncertainty. Do not overwrite it
      // when a package adapter converts its rejection to an invalid result.
      if (
        !(error instanceof UnknownExternalOutcome) &&
        !(error instanceof ProviderRetryScheduled) &&
        !this.signal.aborted
      ) {
        await this.repository.failStep(this.lease, {
          stepKey: key,
          code: 'GENERATION_STEP_FAILED',
          uncertain: false,
        });
      }
      throw error;
    }
  }

  external<T>(
    key: string,
    dependency: unknown,
    kind: QuotaKind,
    group: string,
    work: (signal: AbortSignal) => Promise<T>,
    optionalMedia: true,
  ): Promise<T | null>;
  external<T>(
    key: string,
    dependency: unknown,
    kind: QuotaKind,
    group: string,
    work: (signal: AbortSignal) => Promise<T>,
    optionalMedia?: false,
  ): Promise<T>;
  async external<T>(
    key: string,
    dependency: unknown,
    kind: QuotaKind,
    _group: string,
    work: (signal: AbortSignal) => Promise<T>,
    optionalMedia = false,
  ): Promise<T | null> {
    return this.quota.run(kind, 'deployment', this.signal, async () => {
      this.signal.throwIfAborted();
      assertGenerationConfigSnapshot(this.lease.input);
      const receipt = await this.repository.beginStep(this.lease, {
        key,
        kind,
        dependencyHash: canonicalHash(dependency),
        external: true,
        deadlineMs: EXTERNAL_CALL_DEADLINES_MS[kind],
        outlineId: sceneOutlineId(key),
      });
      if (receipt.status === 'succeeded') return receipt.result as T;
      if (receipt.status === 'skipped' && optionalMedia && kind === 'media') return null;
      const deadline = new AbortController();
      const callSignal = AbortSignal.any([this.signal, deadline.signal]);
      const timeout = setTimeout(
        () => deadline.abort(new Error('PROVIDER_DEADLINE_EXCEEDED')),
        EXTERNAL_CALL_DEADLINES_MS[kind],
      );
      timeout.unref?.();
      // Persist the attempt before sending; this also checks the live DB fence.
      let responseReceived = false;
      try {
        // Race even adapters lacking AbortSignal support. They may still finish
        // remotely, but they cannot keep the Worker lease alive indefinitely or
        // commit late results. Signal-aware adapters also stop their local I/O.
        const invoke = () =>
          kind === 'media' && receipt.attemptId && this.repository.recordProviderRequest
            ? withPolledTaskPersistence(
                {
                  resumeTaskId: receipt.providerRequestId,
                  persistTaskId: (taskId) =>
                    this.repository.recordProviderRequest!(this.lease, {
                      attemptId: receipt.attemptId!,
                      taskId,
                    }),
                },
                () => work(callSignal),
              )
            : work(callSignal);
        const result = await raceWithAbort(callSignal, () =>
          kind === 'llm' ? runWithGenerationQuota(invoke) : invoke(),
        );
        responseReceived = true;
        callSignal.throwIfAborted();
        await this.repository.commitCheckpoint(this.lease, { stepKey: key, result });
        return result;
      } catch (error) {
        // Only provider-confirmed rejection or terminal failure can downgrade an
        // optional image/video. Lost responses and download failures stay unknown.
        if (
          optionalMedia &&
          kind === 'media' &&
          !callSignal.aborted &&
          !responseReceived &&
          error instanceof ConfirmedMediaFailure
        ) {
          try {
            await this.repository.skipStepWithWarning(this.lease, {
              stepKey: key,
              code: error.code,
            });
            return null;
          } catch {
            // A lost warning commit must use the durable uncertain-attempt path.
          }
        }
        const upstream = error as {
          statusCode?: number;
          status?: number;
          name?: string;
          responseHeaders?: Record<string, string>;
        } | null;
        // A response-level rejection is safe to reschedule. Media's post-call
        // download can also fail with 429, so it deliberately stays uncertain.
        if (
          !callSignal.aborted &&
          !responseReceived &&
          kind !== 'media' &&
          (upstream?.statusCode === 429 ||
            upstream?.status === 429 ||
            upstream?.name === 'TTSRateLimitError')
        ) {
          const retryAfter = upstream.responseHeaders?.['retry-after'];
          const seconds = Number(retryAfter);
          const retryAfterMs = retryAfter
            ? Number.isFinite(seconds)
              ? Math.max(1000, seconds * 1000)
              : Math.max(1000, Date.parse(retryAfter) - Date.now())
            : 5000;
          const boundedDelay = Number.isFinite(retryAfterMs)
            ? Math.min(3_600_000, retryAfterMs)
            : 5000;
          await this.quota.cooldown?.(`${kind}:deployment`, boundedDelay);
          await this.repository.failStep(this.lease, {
            stepKey: key,
            code: 'PROVIDER_RATE_LIMITED',
            uncertain: false,
            retryable: true,
            retryAfterMs: boundedDelay,
          });
          const retry = new ProviderRetryScheduled();
          this.stopped.abort(retry);
          throw retry;
        }
        // Even aborts and failed commits can occur after the provider succeeded.
        // If DB is offline this fails too; the expired-attempt reaper makes the
        // same needs_attention decision from the durable running receipt.
        const outcome = new UnknownExternalOutcome(key);
        this.stopped.abort(outcome);
        await this.repository
          .failStep(this.lease, { stepKey: key, code: 'EXTERNAL_RESULT_UNKNOWN', uncertain: true })
          .catch(() => {});
        throw outcome;
      } finally {
        clearTimeout(timeout);
      }
    });
  }
}

function raceWithAbort<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('PROVIDER_CALL_ABORTED'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return work();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

function sceneOutlineId(key: string): string | undefined {
  return /^(?:content|actions|scene|media|tts):([^:]+)/.exec(key)?.[1];
}

/** Stop scheduling after failure, but join active work before releasing a lease. */
export async function mapBounded<T, R>(
  items: T[],
  concurrency: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(
    Array.from({ length: Math.min(items.length, Math.max(1, concurrency)) }, async () => {
      while (!failed && next < items.length) {
        const index = next++;
        try {
          results[index] = await work(items[index]!, index);
        } catch (error) {
          failed = true;
          failure = error;
        }
      }
    }),
  );
  if (failed) throw failure;
  return results;
}
