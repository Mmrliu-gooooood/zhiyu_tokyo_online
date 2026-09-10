import { setTimeout as sleep } from 'node:timers/promises';
import type { GenerationLease } from '@/lib/server/generation-jobs/contracts';
import { GENERATION_WORKER_PIPELINE_VERSIONS } from '@/lib/server/generation-jobs/contracts';

export interface WorkerRepository {
  claim(workerId: string, versions?: string[]): Promise<GenerationLease | null>;
  heartbeat(lease: GenerationLease): Promise<boolean>;
  workerHeartbeat(workerId: string, versions?: string[], draining?: boolean): Promise<void>;
  reapExpired(): Promise<number>;
  expireWaitingJobs(): Promise<number>;
  confirmDuePlans(): Promise<number>;
  releaseExpiredStagedAssets?(): Promise<number>;
}

export interface GenerationWorkerReport {
  event: string;
  jobId?: string;
  category?: string;
  code?: string;
  summary?: string;
  phase?: string;
  elapsedMs?: number;
  deadlineMs?: number;
}

function safeErrorField(error: unknown, field: string): unknown {
  return typeof error === 'object' && error !== null
    ? (error as Record<string, unknown>)[field]
    : undefined;
}

/** Produces bounded diagnostics without serializing provider responses or secrets. */
export function safeWorkerStopReport(
  error: unknown,
  lease: GenerationLease,
  startedAt: number,
  now = Date.now(),
): GenerationWorkerReport {
  const rawCode = safeErrorField(error, 'code');
  const code =
    typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]{2,79}$/.test(rawCode) ? rawCode : undefined;
  const rawPhase = safeErrorField(error, 'phase');
  const phase =
    typeof rawPhase === 'string' && /^[a-z][a-z0-9:_-]{0,39}$/.test(rawPhase)
      ? rawPhase
      : 'execution';
  const rawDeadline = safeErrorField(error, 'deadlineMs') ?? safeErrorField(error, 'timeoutMs');
  const deadlineMs =
    typeof rawDeadline === 'number' &&
    Number.isFinite(rawDeadline) &&
    rawDeadline > 0 &&
    rawDeadline <= 3_600_000
      ? Math.round(rawDeadline)
      : undefined;
  let category = 'unexpected';
  let summary =
    'Generation execution stopped unexpectedly; inspect the durable job failure evidence.';
  if (code === 'TTS_RESULT_UNKNOWN_AFTER_TIMEOUT') {
    category = 'external_result_unknown';
    summary = 'TTS request exceeded its deadline after dispatch; the external result is unknown.';
  } else if (code === 'EXTERNAL_RESULT_UNKNOWN') {
    category = 'external_result_unknown';
    summary = 'External provider request outcome is unknown; durable evidence requires review.';
  } else if (code === 'PROVIDER_REQUEST_NOT_SENT') {
    category = 'provider_request_not_sent';
    summary = 'Provider request was not sent because DNS resolution failed; a bounded retry is safe.';
  } else if (code === 'GENERATION_LEASE_LOST') {
    category = 'lease_lost';
    summary = 'Generation stopped after its durable worker lease was lost.';
  } else if (code === 'WORKER_DRAIN_TIMEOUT') {
    category = 'drain_timeout';
    summary = 'Generation exceeded the worker shutdown grace period and was aborted.';
  } else if (code === 'WORKER_DATABASE_UNAVAILABLE') {
    category = 'database_unavailable';
    summary = 'Generation stopped because the durable database became unavailable.';
  } else if (safeErrorField(error, 'name') === 'AbortError') {
    category = 'aborted';
    summary = 'Generation execution was aborted; durable checkpoints remain authoritative.';
  } else if (code) {
    category = 'generation_error';
    summary = 'Generation stopped with a classified durable pipeline error.';
  }
  return {
    event: 'job_stopped',
    jobId: lease.jobId,
    category,
    ...(code ? { code } : {}),
    summary,
    phase,
    elapsedMs: Math.max(0, Math.round(now - startedAt)),
    ...(deadlineMs ? { deadlineMs } : {}),
  };
}

/** Independent polling process: SIGTERM drains; lease loss aborts provider work. */
export async function runWorker(options: {
  repository: WorkerRepository;
  workerId: string;
  concurrency: number;
  heartbeatMs: number;
  signal: AbortSignal;
  execute: (lease: GenerationLease, signal: AbortSignal) => Promise<unknown>;
  report?: (event: GenerationWorkerReport) => void;
  maintenance?: () => Promise<unknown>;
}) {
  const { repository, workerId, signal } = options;
  const versions = [...GENERATION_WORKER_PIPELINE_VERSIONS];
  const active = new Set<Promise<void>>();
  let maintenanceRunning = false;
  const maintain = async () => {
    if (maintenanceRunning) return;
    maintenanceRunning = true;
    try {
      await repository.workerHeartbeat(workerId, versions, signal.aborted);
      await repository.reapExpired();
      await repository.expireWaitingJobs();
      await repository.confirmDuePlans();
      await repository.releaseExpiredStagedAssets?.();
      await options.maintenance?.();
    } catch {
      options.report?.({ event: 'worker_database_unavailable' });
    } finally {
      maintenanceRunning = false;
    }
  };
  await maintain();
  const maintenance = setInterval(() => {
    void maintain();
  }, options.heartbeatMs);
  const processLease = async (lease: GenerationLease) => {
    const startedAt = Date.now();
    const controller = new AbortController();
    // A normal shutdown permits active work to finish within Docker's grace.
    // If it does not finish, abort and let the durable reaper classify attempts.
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const drain = () => {
      drainTimer = setTimeout(() => controller.abort(new Error('WORKER_DRAIN_TIMEOUT')), 25_000);
    };
    signal.addEventListener('abort', drain, { once: true });
    if (signal.aborted) drain();
    let heartbeatRunning = false;
    const timer = setInterval(() => {
      if (heartbeatRunning) return;
      heartbeatRunning = true;
      void repository
        .heartbeat(lease)
        .then((valid) => {
          if (!valid) controller.abort(new Error('GENERATION_LEASE_LOST'));
        })
        .catch(() => controller.abort(new Error('WORKER_DATABASE_UNAVAILABLE')))
        .finally(() => {
          heartbeatRunning = false;
        });
    }, options.heartbeatMs);
    try {
      options.report?.({ event: 'job_claimed', jobId: lease.jobId });
      await options.execute(lease, controller.signal);
      options.report?.({ event: 'job_yielded', jobId: lease.jobId });
    } catch (error) {
      options.report?.(safeWorkerStopReport(error, lease, startedAt));
    } finally {
      clearInterval(timer);
      if (drainTimer) clearTimeout(drainTimer);
      signal.removeEventListener('abort', drain);
    }
  };
  try {
    while (!signal.aborted) {
      if (active.size >= options.concurrency) {
        await Promise.race(active);
        continue;
      }
      try {
        const lease = await repository.claim(workerId, versions);
        if (lease) {
          const task = processLease(lease).finally(() => active.delete(task));
          active.add(task);
          continue;
        }
      } catch {
        options.report?.({ event: 'worker_claim_unavailable' });
      }
      await sleep(1000, undefined, { signal }).catch(() => {});
    }
  } finally {
    clearInterval(maintenance);
    await repository.workerHeartbeat(workerId, versions, true).catch(() => {});
    await Promise.allSettled(active);
  }
}
