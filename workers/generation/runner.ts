import { setTimeout as sleep } from 'node:timers/promises';
import type { GenerationLease } from '@/lib/server/generation-jobs/contracts';
import { GENERATION_PIPELINE_VERSION } from '@/lib/server/generation-jobs/contracts';

export interface WorkerRepository {
  claim(workerId: string, versions?: string[]): Promise<GenerationLease | null>;
  heartbeat(lease: GenerationLease): Promise<boolean>;
  workerHeartbeat(workerId: string, versions?: string[], draining?: boolean): Promise<void>;
  reapExpired(): Promise<number>;
  expireWaitingJobs(): Promise<number>;
  confirmDuePlans(): Promise<number>;
  releaseExpiredStagedAssets?(): Promise<number>;
}

/** Independent polling process: SIGTERM drains; lease loss aborts provider work. */
export async function runWorker(options: {
  repository: WorkerRepository;
  workerId: string;
  concurrency: number;
  heartbeatMs: number;
  signal: AbortSignal;
  execute: (lease: GenerationLease, signal: AbortSignal) => Promise<unknown>;
  report?: (event: { event: string; jobId?: string }) => void;
  maintenance?: () => Promise<unknown>;
}) {
  const { repository, workerId, signal } = options;
  const versions = [GENERATION_PIPELINE_VERSION];
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
    } catch {
      options.report?.({ event: 'job_stopped', jobId: lease.jobId });
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
