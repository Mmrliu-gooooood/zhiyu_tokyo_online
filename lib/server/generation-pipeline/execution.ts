import { canonicalHash } from '@/lib/server/generation-jobs/contracts';
import type {
  GenerationLease,
  StepReceipt,
  StepStart,
} from '@/lib/server/generation-jobs/contracts';
import { runWithGenerationQuota } from '@/lib/server/generation-jobs/provider-call-context';
import { assertGenerationConfigSnapshot } from '@/lib/server/generation-jobs/config-snapshot';
import { ConfirmedMediaFailure } from '@/lib/media/generation-errors';
import { withPolledTaskPersistence } from '@/lib/server/generation-jobs/polled-task-persistence';
import {
  DEFAULT_TTS_REQUEST_TIMEOUT_MS,
  resolveTTSRequestTimeoutMs,
  TTSConfigurationError,
  TTSProviderTransientError,
  TTSProviderTerminalError,
  TTSRequestTimeoutError,
} from '@/lib/audio/tts-providers';

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
      errorSummary?: string;
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
  constructor(
    readonly stepKey: string,
    readonly code = 'EXTERNAL_RESULT_UNKNOWN',
    readonly safeSummary = 'External provider result is unknown.',
  ) {
    super('EXTERNAL_RESULT_UNKNOWN');
    this.name = 'UnknownExternalOutcome';
  }
}
export class ProviderRetryScheduled extends Error {
  readonly safeToRetry = true;
  constructor(
    readonly code = 'PROVIDER_RATE_LIMITED',
    readonly phase = 'execution',
  ) {
    super(code);
    this.name = 'ProviderRetryScheduled';
  }
}

/** DNS resolution failures prove that no HTTP request reached the provider. */
function requestNotSentTransportCode(error: unknown): 'EAI_AGAIN' | 'ENOTFOUND' | undefined {
  let current = error;
  for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (code === 'EAI_AGAIN' || code === 'ENOTFOUND') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export type QuotaKind = 'llm' | 'tts' | 'media';
const TTS_POST_RESPONSE_GRACE_MS = 15_000;
export const EXTERNAL_CALL_DEADLINES_MS: Readonly<Record<QuotaKind, number>> = {
  llm: 300_000,
  tts: DEFAULT_TTS_REQUEST_TIMEOUT_MS + TTS_POST_RESPONSE_GRACE_MS,
  media: 600_000,
};
export function externalCallDeadlineMs(
  kind: QuotaKind,
  env: Readonly<{ TTS_REQUEST_TIMEOUT_MS?: string }> = process.env as unknown as Readonly<{
    TTS_REQUEST_TIMEOUT_MS?: string;
  }>,
): number {
  return kind === 'tts'
    ? resolveTTSRequestTimeoutMs(env) + TTS_POST_RESPONSE_GRACE_MS
    : EXTERNAL_CALL_DEADLINES_MS[kind];
}

export class ExternalCallInterrupted extends Error {
  constructor(
    readonly code: 'EXTERNAL_CALL_CANCELLED' | 'WORKER_LEASE_LOST',
    readonly requestOutcomeUnknown: boolean,
    readonly safeSummary: string,
  ) {
    super(code);
    this.name = 'ExternalCallInterrupted';
  }
}
export interface QuotaGate {
  run<T>(kind: QuotaKind, group: string, signal: AbortSignal, work: () => Promise<T>): Promise<T>;
  cooldown?(group: string, retryAfterMs: number): Promise<void>;
}

export interface ExternalCallLifecycle {
  markResponseReceived(): void;
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
    work: (signal: AbortSignal, lifecycle: ExternalCallLifecycle) => Promise<T>,
    optionalMedia: true,
  ): Promise<T | null>;
  external<T>(
    key: string,
    dependency: unknown,
    kind: QuotaKind,
    group: string,
    work: (signal: AbortSignal, lifecycle: ExternalCallLifecycle) => Promise<T>,
    optionalMedia?: false,
  ): Promise<T>;
  async external<T>(
    key: string,
    dependency: unknown,
    kind: QuotaKind,
    _group: string,
    work: (signal: AbortSignal, lifecycle: ExternalCallLifecycle) => Promise<T>,
    optionalMedia = false,
  ): Promise<T | null> {
    return this.quota.run(kind, 'deployment', this.signal, async () => {
      this.signal.throwIfAborted();
      assertGenerationConfigSnapshot(this.lease.input);
      const deadlineMs = externalCallDeadlineMs(kind);
      const receipt = await this.repository.beginStep(this.lease, {
        key,
        kind,
        dependencyHash: canonicalHash(dependency),
        external: true,
        deadlineMs,
        outlineId: sceneOutlineId(key),
      });
      if (receipt.status === 'succeeded') return receipt.result as T;
      if (receipt.status === 'skipped' && optionalMedia && kind === 'media') return null;
      const deadline = new AbortController();
      const callSignal = AbortSignal.any([this.signal, deadline.signal]);
      const timeout = setTimeout(
        () => deadline.abort(new Error('PROVIDER_DEADLINE_EXCEEDED')),
        deadlineMs,
      );
      timeout.unref?.();
      // Persist the attempt before sending; this also checks the live DB fence.
      let requestDispatched = false;
      let responseReceived = false;
      let commitStarted = false;
      const lifecycle: ExternalCallLifecycle = {
        markResponseReceived: () => {
          responseReceived = true;
        },
      };
      try {
        // Race even adapters lacking AbortSignal support. They may still finish
        // remotely, but they cannot keep the Worker lease alive indefinitely or
        // commit late results. Signal-aware adapters also stop their local I/O.
        const invoke = () => {
          requestDispatched = true;
          return kind === 'media' && receipt.attemptId && this.repository.recordProviderRequest
            ? withPolledTaskPersistence(
                {
                  resumeTaskId: receipt.providerRequestId,
                  persistTaskId: (taskId) =>
                    this.repository.recordProviderRequest!(this.lease, {
                      attemptId: receipt.attemptId!,
                      taskId,
                    }),
                },
                () => work(callSignal, lifecycle),
              )
            : work(callSignal, lifecycle);
        };
        const result = await raceWithAbort(callSignal, () =>
          kind === 'llm' ? runWithGenerationQuota(invoke) : invoke(),
        );
        responseReceived = true;
        callSignal.throwIfAborted();
        commitStarted = true;
        await this.repository.commitCheckpoint(this.lease, { stepKey: key, result });
        return result;
      } catch (error) {
        if (this.signal.aborted) {
          const reason = this.signal.reason;
          const leaseLost = reason instanceof Error && reason.message === 'GENERATION_LEASE_LOST';
          const interrupted = new ExternalCallInterrupted(
            leaseLost ? 'WORKER_LEASE_LOST' : 'EXTERNAL_CALL_CANCELLED',
            requestDispatched && !responseReceived,
            leaseLost
              ? 'External request was interrupted because the worker lease was lost.'
              : 'External request was interrupted by cancellation after dispatch.',
          );
          this.stopped.abort(interrupted);
          throw interrupted;
        }
        if (kind === 'tts' && error instanceof TTSConfigurationError) {
          await this.repository.failStep(this.lease, {
            stepKey: key,
            code: error.code,
            uncertain: false,
            errorSummary: error.safeSummary,
          });
          this.stopped.abort(error);
          throw error;
        }
        if (kind === 'tts' && error instanceof TTSProviderTerminalError) {
          await this.repository.failStep(this.lease, {
            stepKey: key,
            code: error.code,
            uncertain: false,
            errorSummary: error.safeSummary,
          });
          this.stopped.abort(error);
          throw error;
        }
        if (kind === 'tts' && error instanceof TTSProviderTransientError) {
          await this.repository.failStep(this.lease, {
            stepKey: key,
            code: error.code,
            uncertain: false,
            errorSummary: error.safeSummary,
          });
          // A generic 5xx is transient, but it does not prove that a paid
          // request was never accepted. Keep its distinct evidence and stop;
          // only provider-confirmed safe rejections (the 429 path below) are
          // automatically rescheduled.
          this.stopped.abort(error);
          throw error;
        }
        const requestNotSentCode = requestNotSentTransportCode(error);
        // Media adapters may submit a paid task and only then hit DNS while
        // polling/downloading, so their DNS failures must remain unknown.
        if (kind !== 'media' && !callSignal.aborted && !responseReceived && requestNotSentCode) {
          await this.repository.failStep(this.lease, {
            stepKey: key,
            code: 'PROVIDER_REQUEST_NOT_SENT',
            uncertain: false,
            errorSummary: 'Provider request was not sent because DNS resolution failed.',
            retryable: true,
            retryAfterMs: 5000,
          });
          const retry = new ProviderRetryScheduled('PROVIDER_REQUEST_NOT_SENT', key);
          this.stopped.abort(retry);
          throw retry;
        }
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
            errorSummary: 'Provider explicitly rejected the request with HTTP 429.',
            retryable: true,
            retryAfterMs: boundedDelay,
          });
          const retry = new ProviderRetryScheduled('PROVIDER_RATE_LIMITED', key);
          this.stopped.abort(retry);
          throw retry;
        }
        // Even aborts and failed commits can occur after the provider succeeded.
        // If DB is offline this fails too; the expired-attempt reaper makes the
        // same needs_attention decision from the durable running receipt.
        const commitFailure = kind === 'tts' && commitStarted;
        const persistFailure = kind === 'tts' && responseReceived && !commitStarted;
        const timeoutFailure =
          kind === 'tts' &&
          (error instanceof TTSRequestTimeoutError ||
            (deadline.signal.aborted && !this.signal.aborted));
        const timeoutCode = 'TTS_RESULT_UNKNOWN_AFTER_TIMEOUT';
        const timeoutSummary =
          'TTS provider did not return before the deadline; its result is unknown.';
        const outcome = new UnknownExternalOutcome(
          key,
          commitFailure
            ? 'TTS_RESULT_COMMIT_FAILED'
            : persistFailure
              ? 'TTS_RESULT_PERSIST_FAILED'
              : timeoutFailure
                ? error instanceof TTSRequestTimeoutError
                  ? error.code
                  : timeoutCode
                : undefined,
          commitFailure
            ? 'TTS result was produced, but its checkpoint could not be committed.'
            : persistFailure
              ? 'TTS response was received, but its audio asset could not be persisted.'
              : timeoutFailure
                ? error instanceof TTSRequestTimeoutError
                  ? error.safeSummary
                  : timeoutSummary
                : undefined,
        );
        this.stopped.abort(outcome);
        await this.repository
          .failStep(this.lease, {
            stepKey: key,
            code: outcome.code,
            uncertain: true,
            errorSummary: outcome.safeSummary,
          })
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
