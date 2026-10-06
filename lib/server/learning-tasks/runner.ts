/**
 * Learning-task runner hosted by the generation worker process (no new
 * service). It claims tasks through the shared heavy-task admission, dispatches
 * each by kind, keeps its lease alive, and drains on shutdown: no new claims,
 * running tasks get a grace period, then are aborted and re-queued.
 */
import { randomUUID } from 'node:crypto';

import { withHeavyTaskRootContext } from '@/lib/server/heavy-task-admission';

import type { LearningTaskKind, LearningTaskLease } from './contracts';
import type { LearningTaskQueue } from './repository';

export interface LearningTaskHandlerContext {
  queue: LearningTaskQueue;
  signal: AbortSignal;
}

/**
 * A kind handler. It settles its own task through `queue.complete` /
 * `queue.fail`; throwing settles it as a failure using the error's `code` and
 * `retryable` fields when present.
 */
export type LearningTaskHandler = (
  lease: LearningTaskLease,
  context: LearningTaskHandlerContext,
) => Promise<void>;

export interface LearningTaskRunnerOptions {
  queue: LearningTaskQueue;
  handlers: Partial<Record<LearningTaskKind, LearningTaskHandler>>;
  workerId?: string;
  concurrency?: number;
  scanIntervalMs?: number;
  heartbeatMs?: number;
  drainTimeoutMs?: number;
  /** Deletes one object an abandoned attempt staged; enables the staged-object sweep. */
  removeStagedObject?: (key: string) => Promise<void>;
  report?: (event: { event: string; taskId?: string; code?: string }) => void;
}

export interface LearningTaskRunnerHandle {
  workerId: string;
  /** Stop claiming, publish draining, wait for running tasks, then abort the rest. */
  stop(): Promise<void>;
}

class RunnerAbort extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'RunnerAbort';
  }
}

function errorCode(error: unknown): string {
  const code =
    error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
  return code && /^[A-Z0-9_]{1,100}$/.test(code) ? code : 'LEARNING_TASK_FAILED';
}

function errorRetryable(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' && 'retryable' in error && error.retryable === true,
  );
}

export function learningTaskWorkerConcurrency(env = process.env): number {
  const raw = env.LEARNING_TASK_WORKER_CONCURRENCY?.trim();
  if (!raw) return 1;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 4) {
    throw new Error('Invalid LEARNING_TASK_WORKER_CONCURRENCY (1-4)');
  }
  return value;
}

export function startLearningTaskRunner(
  options: LearningTaskRunnerOptions,
): LearningTaskRunnerHandle {
  const workerId = options.workerId ?? `${process.pid}:${randomUUID()}`;
  const { queue } = options;
  const kinds = Object.keys(options.handlers) as LearningTaskKind[];
  const concurrency = options.concurrency ?? 1;
  const heartbeatMs = options.heartbeatMs ?? 10_000;
  const report = options.report ?? (() => undefined);
  const running = new Map<string, { promise: Promise<void>; controller: AbortController }>();
  let stopping = false;
  let scanning = false;
  let maintaining = false;

  const maintain = async () => {
    if (maintaining) return;
    maintaining = true;
    try {
      await queue.workerHeartbeat(workerId, stopping, kinds);
      if (!stopping) {
        await queue.reapExpired();
        await queue.expireQueued();
        if (options.removeStagedObject) await queue.sweepStagedObjects(options.removeStagedObject);
      }
    } catch {
      report({ event: 'learning_task_database_unavailable' });
    } finally {
      maintaining = false;
    }
  };

  const run = (lease: LearningTaskLease) => {
    const controller = new AbortController();
    const handler = options.handlers[lease.kind]!;
    let heartbeatRunning = false;
    const heartbeat = setInterval(() => {
      if (heartbeatRunning) return;
      heartbeatRunning = true;
      void queue
        .heartbeat(lease)
        .then((alive) => {
          if (!alive) controller.abort(new RunnerAbort('LEARNING_TASK_LEASE_LOST'));
        })
        .catch(() => controller.abort(new RunnerAbort('WORKER_DATABASE_UNAVAILABLE')))
        .finally(() => {
          heartbeatRunning = false;
        });
    }, heartbeatMs);
    const deadline = setTimeout(
      () => controller.abort(new RunnerAbort('LEARNING_TASK_DEADLINE')),
      Math.max(1000, lease.deadlineAt - Date.now()),
    );
    const promise = (async () => {
      report({ event: 'learning_task_claimed', taskId: lease.taskId });
      try {
        await withHeavyTaskRootContext(
          { ownerId: lease.ownerId, rootTaskId: lease.rootTaskId, kind: 'learning-task' },
          () => handler(lease, { queue, signal: controller.signal }),
        );
      } catch (error) {
        const reason = controller.signal.aborted ? controller.signal.reason : error;
        const code = reason instanceof RunnerAbort ? reason.code : errorCode(reason);
        report({ event: 'learning_task_stopped', taskId: lease.taskId, code });
        // A lost lease belongs to someone else now: only close this attempt's
        // row. Anything else is settled here.
        if (code === 'LEARNING_TASK_LEASE_LOST') {
          await queue
            .recordLostAttempt(lease, { usageCompleteness: 'unknown' })
            .catch(() => undefined);
        } else {
          await queue
            .fail(lease, {
              code,
              retryable:
                code === 'WORKER_DRAIN_TIMEOUT' ||
                code === 'WORKER_DATABASE_UNAVAILABLE' ||
                (!(reason instanceof RunnerAbort) && errorRetryable(reason)),
              summary: reason instanceof Error ? reason.message : undefined,
              usageCompleteness: 'unknown',
            })
            .catch(() => report({ event: 'learning_task_settle_failed', taskId: lease.taskId }));
        }
      } finally {
        clearInterval(heartbeat);
        clearTimeout(deadline);
        running.delete(lease.taskId);
      }
    })();
    running.set(lease.taskId, { promise, controller });
  };

  const scan = async () => {
    if (stopping || scanning || kinds.length === 0) return;
    scanning = true;
    try {
      while (!stopping && running.size < concurrency) {
        const lease = await queue.claim(workerId, kinds);
        if (!lease) break;
        run(lease);
      }
    } catch {
      report({ event: 'learning_task_claim_unavailable' });
    } finally {
      scanning = false;
    }
  };

  void maintain().then(() => scan());
  const maintenanceTimer = setInterval(() => void maintain(), heartbeatMs);
  const scanTimer = setInterval(() => void scan(), options.scanIntervalMs ?? 2000);

  return {
    workerId,
    async stop() {
      if (stopping) return;
      stopping = true;
      clearInterval(scanTimer);
      clearInterval(maintenanceTimer);
      await maintain();
      const graceUntil = Date.now() + (options.drainTimeoutMs ?? 20_000);
      while ((scanning || running.size > 0) && Date.now() < graceUntil) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      for (const task of running.values()) {
        task.controller.abort(new RunnerAbort('WORKER_DRAIN_TIMEOUT'));
      }
      await Promise.allSettled([...running.values()].map((task) => task.promise));
      await queue.workerHeartbeat(workerId, true, kinds).catch(() => undefined);
    },
  };
}
