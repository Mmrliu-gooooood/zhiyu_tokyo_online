/**
 * learning_tasks persistence (learning plan B02+).
 *
 * Owner-side operations (enqueue, read, cancel, retry) take the caller's
 * owner-bound transaction so they commit together with the business rows that
 * requested them. Worker-side operations (claim, heartbeat, settle, reap) run
 * on the worker pool through LearningTaskQueue and are fenced by the lease
 * epoch exactly like generation jobs: a cancelled, reaped or reclaimed task
 * can never be settled by its previous holder.
 */
import { createHash, randomUUID } from 'node:crypto';

import type { Queryable } from '@openmaic/storage/document/pg';

import type { TransactionSource } from '@/lib/persistence/owner-bound-document-store';
import { isHostedAuthEnabled } from '@/lib/auth/mode';
import { agentRuntimeConfig } from '@/lib/server/agent-runtime/config';
import {
  checkHeavyTaskAdmission,
  checkHeavyTaskQueueCapacity,
  heavyTaskQueueWaitMs,
} from '@/lib/server/heavy-task-admission';
import {
  admitHeavyTaskClaim,
  claimAccountFenceSql,
  lockHeavyTaskAdmission,
  runQueueTransaction,
  safeTaskErrorCode,
  sanitizeTaskErrorSummary,
  taskRetryDelayMs,
  tryLockClaimOwner,
} from '@/lib/server/task-queue/lease-queue';

import {
  LEARNING_TASK_WORKER_CAPABILITY,
  LearningTaskError,
  NON_RETRYABLE_TASK_CODES,
  isLearningTaskKind,
  learningTaskRootId,
  type LearningTaskKind,
  type LearningTaskLease,
  type LearningTaskStatus,
  type LearningTaskUsageCompleteness,
  type LearningTaskView,
} from './contracts';

interface TaskRow extends Record<string, unknown> {
  id: string;
  owner_id: string;
  root_task_id: string;
  kind: string;
  idempotency_key: string;
  request_hash: string;
  subject_id: string;
  status: LearningTaskStatus;
  input: Record<string, unknown>;
  result: Record<string, unknown> | null;
  attempt_count: number;
  max_attempts: number;
  budget: { activeMs?: number } | null;
  usage_completeness: LearningTaskUsageCompleteness;
  worker_id: string | null;
  lease_epoch: number | string;
  lease_expires_at: Date | string | null;
  available_at: Date | string;
  last_error_code: string | null;
  last_error_summary: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
}

const TERMINAL = new Set<LearningTaskStatus>(['succeeded', 'failed', 'cancelled']);
export const DEFAULT_TASK_MAX_ATTEMPTS = 3;
export const DEFAULT_TASK_ACTIVE_MS = 10 * 60 * 1000;

function iso(value: Date | string | null): string | null {
  return value === null ? null : (value instanceof Date ? value : new Date(value)).toISOString();
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function learningTaskRequestHash(
  kind: LearningTaskKind,
  subjectId: string,
  input: unknown,
): string {
  return createHash('sha256').update(canonical({ kind, subjectId, input })).digest('hex');
}

function view(row: TaskRow, queueReason: LearningTaskView['queueReason'] = null): LearningTaskView {
  const status = row.status;
  const code = row.last_error_code;
  return {
    taskId: row.id,
    kind: row.kind as LearningTaskKind,
    subjectId: row.subject_id,
    status,
    queueReason: status === 'queued' ? (queueReason ?? 'queued') : null,
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    lastErrorCode: code,
    lastErrorSummary: row.last_error_summary,
    retryAt: status === 'retry_wait' ? iso(row.available_at) : null,
    usageCompleteness: row.usage_completeness,
    result: row.result ?? null,
    providerId: typeof row.input?.providerId === 'string' ? row.input.providerId : null,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    cancelable: !TERMINAL.has(status),
    retryable:
      (status === 'failed' || status === 'cancelled') &&
      !(code && NON_RETRYABLE_TASK_CODES.has(code)),
  };
}

/** Explain a queued task: waiting its turn, or held by a personal/site concurrency limit. */
async function queuedView(q: Queryable, row: TaskRow): Promise<LearningTaskView> {
  if (row.status !== 'queued') return view(row);
  try {
    const admission = await checkHeavyTaskAdmission(q, {
      ownerId: row.owner_id,
      rootTaskId: row.root_task_id,
      kind: 'learning-task',
      agentLeaseTtlMs: agentRuntimeConfig.leaseTtlMs,
      lock: false,
    });
    return view(
      row,
      admission.allowed
        ? 'queued'
        : admission.reason === 'personal_limit'
          ? 'owner_limit'
          : 'site_limit',
    );
  } catch {
    return view(row);
  }
}

// ── owner side ────────────────────────────────────────────────────────────

export interface EnqueueLearningTaskInput {
  ownerId: string;
  kind: LearningTaskKind;
  subjectId: string;
  idempotencyKey: string;
  input: Record<string, unknown>;
  maxAttempts?: number;
  activeMs?: number;
}

/**
 * Accept one task in the caller's transaction. The same key with the same
 * request returns the existing task; a different request under that key is a
 * conflict. New roots must fit the shared personal/site queue capacity.
 */
export async function enqueueLearningTask(
  q: Queryable,
  request: EnqueueLearningTaskInput,
): Promise<{ task: LearningTaskView; created: boolean }> {
  if (!request.idempotencyKey || request.idempotencyKey.length > 200) {
    throw new LearningTaskError('LEARNING_TASK_INVALID_IDEMPOTENCY_KEY');
  }
  const hash = learningTaskRequestHash(request.kind, request.subjectId, request.input);
  await q.query("SELECT pg_advisory_xact_lock(hashtext('learning-task:owner:' || $1))", [
    request.ownerId,
  ]);
  const found = await q.query<TaskRow>(
    'SELECT * FROM learning_tasks WHERE owner_id=$1 AND idempotency_key=$2',
    [request.ownerId, request.idempotencyKey],
  );
  if (found.rows[0]) {
    if (found.rows[0].request_hash !== hash) {
      throw new LearningTaskError('LEARNING_TASK_IDEMPOTENCY_CONFLICT');
    }
    return { task: await queuedView(q, found.rows[0]), created: false };
  }
  const id = randomUUID();
  const rootTaskId = learningTaskRootId(id);
  const capacity = await checkHeavyTaskQueueCapacity(q, { ownerId: request.ownerId, rootTaskId });
  if (!capacity.allowed) {
    throw new LearningTaskError(
      capacity.reason === 'personal_queue_limit'
        ? 'LEARNING_TASK_OWNER_QUEUE_LIMIT'
        : 'LEARNING_TASK_QUEUE_FULL',
    );
  }
  const inserted = await q.query<TaskRow>(
    `INSERT INTO learning_tasks
       (id, owner_id, root_task_id, kind, idempotency_key, request_hash, subject_id,
        input, max_attempts, budget)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb)
     RETURNING *`,
    [
      id,
      request.ownerId,
      rootTaskId,
      request.kind,
      request.idempotencyKey,
      hash,
      request.subjectId,
      JSON.stringify(request.input),
      request.maxAttempts ?? DEFAULT_TASK_MAX_ATTEMPTS,
      JSON.stringify({ activeMs: request.activeMs ?? DEFAULT_TASK_ACTIVE_MS }),
    ],
  );
  return { task: await queuedView(q, inserted.rows[0]), created: true };
}

export async function getLearningTask(
  q: Queryable,
  ownerId: string,
  taskId: string,
): Promise<LearningTaskView | null> {
  if (!/^[0-9a-f-]{36}$/i.test(taskId)) return null;
  const result = await q.query<TaskRow>(
    'SELECT * FROM learning_tasks WHERE id=$1 AND owner_id=$2',
    [taskId, ownerId],
  );
  return result.rows[0] ? queuedView(q, result.rows[0]) : null;
}

/** Newest tasks for the given subjects (e.g. material versions), newest first per subject. */
export async function listLearningTasksForSubjects(
  q: Queryable,
  ownerId: string,
  subjectIds: readonly string[],
  perSubject = 5,
): Promise<LearningTaskView[]> {
  if (subjectIds.length === 0) return [];
  const result = await q.query<TaskRow>(
    `SELECT * FROM (
       SELECT t.*, row_number() OVER (PARTITION BY subject_id ORDER BY created_at DESC, id DESC) AS rn
         FROM learning_tasks t
        WHERE owner_id=$1 AND subject_id=ANY($2::text[])
     ) ranked WHERE rn <= $3
     ORDER BY created_at DESC, id DESC`,
    [ownerId, [...subjectIds], perSubject],
  );
  return Promise.all(result.rows.map((row) => queuedView(q, row)));
}

/** Whether a subject has a task that may still produce a result. */
export async function hasLiveLearningTask(
  q: Queryable,
  ownerId: string,
  subjectId: string,
): Promise<boolean> {
  const result = await q.query<{ live: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM learning_tasks WHERE owner_id=$1 AND subject_id=$2
       AND status IN ('queued','running','retry_wait')) AS live`,
    [ownerId, subjectId],
  );
  return result.rows[0]?.live === true;
}

async function lockOwnedTask(q: Queryable, ownerId: string, taskId: string): Promise<TaskRow> {
  if (!/^[0-9a-f-]{36}$/i.test(taskId)) throw new LearningTaskError('LEARNING_TASK_NOT_FOUND');
  const result = await q.query<TaskRow>(
    'SELECT * FROM learning_tasks WHERE id=$1 AND owner_id=$2 FOR UPDATE',
    [taskId, ownerId],
  );
  if (!result.rows[0]) throw new LearningTaskError('LEARNING_TASK_NOT_FOUND');
  return result.rows[0];
}

/**
 * Cancel a task. A running holder is fenced by bumping the lease epoch; its
 * late result is rejected and its in-flight attempt is recorded as cancelled.
 * Cancelling a finished task is a no-op that returns the task.
 */
export async function cancelLearningTask(
  q: Queryable,
  ownerId: string,
  taskId: string,
): Promise<LearningTaskView> {
  const row = await lockOwnedTask(q, ownerId, taskId);
  if (TERMINAL.has(row.status)) return view(row);
  const updated = await q.query<TaskRow>(
    `UPDATE learning_tasks
        SET status='cancelled', cancel_requested_at=clock_timestamp(), worker_id=NULL,
            lease_expires_at=NULL, lease_epoch=lease_epoch+1, finished_at=clock_timestamp(),
            state_version=state_version+1, updated_at=clock_timestamp()
      WHERE id=$1 RETURNING *`,
    [taskId],
  );
  return view(updated.rows[0]);
}

/** Cancel every unfinished task of the given subjects (used before deleting them). */
export async function cancelLearningTasksForSubjects(
  q: Queryable,
  ownerId: string,
  subjectIds: readonly string[],
): Promise<number> {
  if (subjectIds.length === 0) return 0;
  const result = await q.query<{ id: string }>(
    `UPDATE learning_tasks
        SET status='cancelled', cancel_requested_at=clock_timestamp(), worker_id=NULL,
            lease_expires_at=NULL, lease_epoch=lease_epoch+1, finished_at=clock_timestamp(),
            last_error_code=COALESCE(last_error_code,'MATERIAL_DELETED'),
            state_version=state_version+1, updated_at=clock_timestamp()
      WHERE owner_id=$1 AND subject_id=ANY($2::text[])
        AND status IN ('queued','running','retry_wait')
      RETURNING id`,
    [ownerId, [...subjectIds]],
  );
  return result.rows.length;
}

/**
 * Re-queue a failed or cancelled task with a fresh attempt budget. It joins
 * the queue again under the same root, so queue capacity applies.
 */
export async function retryLearningTask(
  q: Queryable,
  ownerId: string,
  taskId: string,
): Promise<LearningTaskView> {
  await q.query("SELECT pg_advisory_xact_lock(hashtext('learning-task:owner:' || $1))", [ownerId]);
  const row = await lockOwnedTask(q, ownerId, taskId);
  const current = view(row);
  if (!current.retryable) throw new LearningTaskError('LEARNING_TASK_NOT_RETRYABLE');
  const capacity = await checkHeavyTaskQueueCapacity(q, {
    ownerId,
    rootTaskId: row.root_task_id,
  });
  if (!capacity.allowed) {
    throw new LearningTaskError(
      capacity.reason === 'personal_queue_limit'
        ? 'LEARNING_TASK_OWNER_QUEUE_LIMIT'
        : 'LEARNING_TASK_QUEUE_FULL',
    );
  }
  const updated = await q.query<TaskRow>(
    `UPDATE learning_tasks
        SET status='queued', max_attempts=LEAST(20, attempt_count+$2), cancel_requested_at=NULL,
            last_error_code=NULL, last_error_summary=NULL, result=NULL, worker_id=NULL,
            lease_expires_at=NULL, available_at=clock_timestamp(), finished_at=NULL,
            state_version=state_version+1, updated_at=clock_timestamp()
      WHERE id=$1 RETURNING *`,
    [taskId, DEFAULT_TASK_MAX_ATTEMPTS],
  );
  return queuedView(q, updated.rows[0]);
}

// ── worker side ───────────────────────────────────────────────────────────

export interface LearningTaskQueueConfig {
  leaseMs: number;
  queueWaitMs: number;
}

export function learningTaskQueueConfig(): LearningTaskQueueConfig {
  return { leaseMs: 60_000, queueWaitMs: heavyTaskQueueWaitMs() };
}

export interface LearningTaskOutcome {
  result: Record<string, unknown>;
  providerId?: string;
  usage?: Record<string, unknown>;
  usageCompleteness?: LearningTaskUsageCompleteness;
}

export interface LearningTaskFailure {
  code: string;
  summary?: string;
  retryable: boolean;
  retryAfterMs?: number;
  providerId?: string;
  usage?: Record<string, unknown>;
  usageCompleteness?: LearningTaskUsageCompleteness;
}

export class LearningTaskQueue {
  readonly config: LearningTaskQueueConfig;

  constructor(
    readonly pool: TransactionSource,
    options: Partial<LearningTaskQueueConfig> = {},
  ) {
    this.config = { ...learningTaskQueueConfig(), ...options };
  }

  transaction<T>(body: (q: Queryable) => Promise<T>): Promise<T> {
    return runQueueTransaction(this.pool, body);
  }

  /** Claim the oldest admissible task of the given kinds, or null. */
  async claim(
    workerId: string,
    kinds: readonly LearningTaskKind[],
  ): Promise<LearningTaskLease | null> {
    return this.transaction(async (q) => {
      await lockHeavyTaskAdmission(q);
      const fence = claimAccountFenceSql('candidate');
      let offset = 0;
      for (;;) {
        const rows = await q.query<TaskRow>(
          `SELECT * FROM learning_tasks AS candidate
            WHERE ((status='queued' AND updated_at>clock_timestamp()-$2*interval '1 millisecond')
                   OR status='retry_wait')
              ${fence}
              AND available_at<=clock_timestamp()
              AND kind=ANY($1::text[])
            ORDER BY available_at, created_at, id
            LIMIT 20 OFFSET $3 FOR UPDATE SKIP LOCKED`,
          [[...kinds], this.config.queueWaitMs, offset],
        );
        for (const row of rows.rows) {
          if (!isLearningTaskKind(row.kind)) continue;
          if (!(await tryLockClaimOwner(q, 'learning-task', row.owner_id))) continue;
          if (
            !(await admitHeavyTaskClaim(q, {
              ownerId: row.owner_id,
              rootTaskId: row.root_task_id,
              kind: 'learning-task',
              agentLeaseTtlMs: agentRuntimeConfig.leaseTtlMs,
            }))
          )
            continue;
          const claimed = await q.query<TaskRow & { deadline_ms: string }>(
            `UPDATE learning_tasks
                SET status='running', worker_id=$2, lease_epoch=lease_epoch+1,
                    lease_expires_at=clock_timestamp()+$3*interval '1 millisecond',
                    heartbeat_at=clock_timestamp(), started_at=COALESCE(started_at,clock_timestamp()),
                    attempt_count=attempt_count+1, state_version=state_version+1,
                    updated_at=clock_timestamp()
              WHERE id=$1
              RETURNING *, (extract(epoch FROM clock_timestamp())*1000)::bigint::text AS deadline_ms`,
            [row.id, workerId, this.config.leaseMs],
          );
          const task = claimed.rows[0];
          const attemptId = randomUUID();
          await q.query(
            `INSERT INTO learning_task_attempts
               (id, task_id, owner_id, attempt_no, lease_epoch, worker_id, provider_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [
              attemptId,
              task.id,
              task.owner_id,
              Number(task.attempt_count),
              Number(task.lease_epoch),
              workerId,
              typeof task.input?.providerId === 'string' ? task.input.providerId : null,
            ],
          );
          return {
            taskId: task.id,
            ownerId: task.owner_id,
            rootTaskId: task.root_task_id,
            kind: task.kind as LearningTaskKind,
            subjectId: task.subject_id,
            input: task.input ?? {},
            workerId,
            leaseEpoch: Number(task.lease_epoch),
            attemptId,
            attemptNo: Number(task.attempt_count),
            deadlineAt:
              Number(task.deadline_ms) + Number(task.budget?.activeMs ?? DEFAULT_TASK_ACTIVE_MS),
          };
        }
        if (rows.rows.length < 20) return null;
        offset += rows.rows.length;
      }
    });
  }

  /** Extend a live lease; false once it was cancelled, reaped or reclaimed. */
  async heartbeat(lease: LearningTaskLease): Promise<boolean> {
    return this.transaction(async (q) => {
      const result = await q.query<{ id: string }>(
        `UPDATE learning_tasks
            SET heartbeat_at=clock_timestamp(),
                lease_expires_at=clock_timestamp()+$4*interval '1 millisecond'
          WHERE id=$1 AND worker_id=$2 AND lease_epoch=$3 AND status='running'
            AND lease_expires_at>clock_timestamp()
          RETURNING id`,
        [lease.taskId, lease.workerId, lease.leaseEpoch, this.config.leaseMs],
      );
      return result.rows.length === 1;
    });
  }

  /** Lock the task row and require that this lease still holds it. */
  async assertLease(q: Queryable, lease: LearningTaskLease): Promise<void> {
    const result = await q.query<{ alive: boolean }>(
      `SELECT (status='running' AND worker_id=$2 AND lease_epoch=$3
               AND lease_expires_at>clock_timestamp()) AS alive
         FROM learning_tasks WHERE id=$1 FOR UPDATE`,
      [lease.taskId, lease.workerId, lease.leaseEpoch],
    );
    if (result.rows[0]?.alive !== true) throw new LearningTaskError('STALE_LEARNING_TASK_LEASE');
  }

  /**
   * Settle success. `commit` writes the task's business result in the same
   * lease-fenced transaction; it returns false when the lease was lost, in
   * which case nothing is written and the caller discards its staged objects.
   */
  async complete(
    lease: LearningTaskLease,
    outcome: LearningTaskOutcome,
    commit?: (q: Queryable) => Promise<void>,
  ): Promise<boolean> {
    try {
      await this.transaction(async (q) => {
        await this.assertLease(q, lease);
        await commit?.(q);
        await q.query(
          `UPDATE learning_tasks
              SET status='succeeded', result=$2::jsonb, usage_completeness=$3,
                  last_error_code=NULL, last_error_summary=NULL, worker_id=NULL,
                  lease_expires_at=NULL, lease_epoch=lease_epoch+1, finished_at=clock_timestamp(),
                  state_version=state_version+1, updated_at=clock_timestamp()
            WHERE id=$1`,
          [lease.taskId, JSON.stringify(outcome.result), outcome.usageCompleteness ?? 'none'],
        );
        await q.query(
          `UPDATE learning_task_attempts
              SET outcome='succeeded', provider_id=COALESCE($2,provider_id), usage=$3::jsonb,
                  usage_completeness=$4, finished_at=clock_timestamp()
            WHERE id=$1 AND outcome='running'`,
          [
            lease.attemptId,
            outcome.providerId ?? null,
            outcome.usage ? JSON.stringify(outcome.usage) : null,
            outcome.usageCompleteness ?? 'none',
          ],
        );
      });
      return true;
    } catch (error) {
      if (error instanceof LearningTaskError && error.code === 'STALE_LEARNING_TASK_LEASE') {
        await this.recordLostAttempt(lease, outcome).catch(() => undefined);
        return false;
      }
      throw error;
    }
  }

  /** Settle a failed attempt: bounded retry with backoff, else a terminal failure. */
  async fail(lease: LearningTaskLease, failure: LearningTaskFailure): Promise<boolean> {
    const code = safeTaskErrorCode(failure.code, 'LEARNING_TASK_FAILED');
    const summary = sanitizeTaskErrorSummary(failure.summary);
    try {
      await this.transaction(async (q) => {
        await this.assertLease(q, lease);
        const task = await q.query<{ attempt_count: number; max_attempts: number }>(
          'SELECT attempt_count, max_attempts FROM learning_tasks WHERE id=$1',
          [lease.taskId],
        );
        const attempts = Number(task.rows[0]?.attempt_count ?? 0);
        const retry = failure.retryable && attempts < Number(task.rows[0]?.max_attempts ?? 0);
        await q.query(
          `UPDATE learning_tasks
              SET status=$2, last_error_code=$3, last_error_summary=$4, worker_id=NULL,
                  lease_expires_at=NULL, lease_epoch=lease_epoch+1,
                  available_at=clock_timestamp()+$5*interval '1 millisecond',
                  usage_completeness=CASE WHEN $6::text='none' THEN usage_completeness ELSE $6::text END,
                  finished_at=CASE WHEN $2='failed' THEN clock_timestamp() ELSE NULL END,
                  state_version=state_version+1, updated_at=clock_timestamp()
            WHERE id=$1`,
          [
            lease.taskId,
            retry ? 'retry_wait' : 'failed',
            code,
            summary,
            retry ? taskRetryDelayMs(attempts, failure.retryAfterMs ?? 0) : 0,
            failure.usageCompleteness ?? 'none',
          ],
        );
        await q.query(
          `UPDATE learning_task_attempts
              SET outcome='failed', error_code=$2, provider_id=COALESCE($3,provider_id),
                  usage=$4::jsonb, usage_completeness=$5, finished_at=clock_timestamp()
            WHERE id=$1 AND outcome='running'`,
          [
            lease.attemptId,
            code,
            failure.providerId ?? null,
            failure.usage ? JSON.stringify(failure.usage) : null,
            failure.usageCompleteness ?? 'unknown',
          ],
        );
      });
      return true;
    } catch (error) {
      if (error instanceof LearningTaskError && error.code === 'STALE_LEARNING_TASK_LEASE') {
        await this.recordLostAttempt(lease, failure).catch(() => undefined);
        return false;
      }
      throw error;
    }
  }

  /**
   * A fenced-out holder (cancelled, reaped or reclaimed task) still closes its
   * attempt row with what it consumed, as cancelled or lease_lost.
   */
  async recordLostAttempt(
    lease: LearningTaskLease,
    detail: { usage?: Record<string, unknown>; usageCompleteness?: string; providerId?: string },
  ): Promise<void> {
    await this.transaction(async (q) => {
      const task = await q.query<{ status: string }>(
        'SELECT status FROM learning_tasks WHERE id=$1',
        [lease.taskId],
      );
      await q.query(
        `UPDATE learning_task_attempts
            SET outcome=$2, provider_id=COALESCE($3,provider_id), usage=$4::jsonb,
                usage_completeness=$5, finished_at=clock_timestamp()
          WHERE id=$1 AND outcome IN ('running','lease_lost')`,
        [
          lease.attemptId,
          task.rows[0]?.status === 'cancelled' ? 'cancelled' : 'lease_lost',
          detail.providerId ?? null,
          detail.usage ? JSON.stringify(detail.usage) : null,
          detail.usageCompleteness ?? 'unknown',
        ],
      );
    });
  }

  /**
   * Recover tasks whose holder stopped heartbeating (worker crash or restart).
   * Free local work is re-queued; an attempt that may have incurred an
   * external charge fails with EXTERNAL_RESULT_UNKNOWN for an explicit retry.
   */
  async reapExpired(): Promise<number> {
    return this.transaction(async (q) => {
      const rows = await q.query<TaskRow>(
        `SELECT * FROM learning_tasks
          WHERE status='running' AND lease_expires_at<=clock_timestamp()
          LIMIT 20 FOR UPDATE SKIP LOCKED`,
      );
      for (const row of rows.rows) {
        const external = row.input?.externalCost === true;
        const retry = !external && Number(row.attempt_count) < Number(row.max_attempts);
        await q.query(
          `UPDATE learning_task_attempts SET outcome='lease_lost', finished_at=clock_timestamp()
            WHERE task_id=$1 AND outcome='running'`,
          [row.id],
        );
        await q.query(
          `UPDATE learning_tasks
              SET status=$2, last_error_code=$3, worker_id=NULL, lease_expires_at=NULL,
                  lease_epoch=lease_epoch+1, available_at=clock_timestamp(),
                  usage_completeness=CASE WHEN $4 THEN 'unknown' ELSE usage_completeness END,
                  finished_at=CASE WHEN $2='failed' THEN clock_timestamp() ELSE NULL END,
                  state_version=state_version+1, updated_at=clock_timestamp()
            WHERE id=$1`,
          [
            row.id,
            retry ? 'retry_wait' : 'failed',
            external ? 'EXTERNAL_RESULT_UNKNOWN' : 'WORKER_LEASE_EXPIRED',
            external,
          ],
        );
      }
      // An attempt whose holder was fenced out (cancel, re-claim) and then died
      // before closing its own row: close it once its lease window has passed.
      await q.query(
        `UPDATE learning_task_attempts attempt
            SET outcome=CASE WHEN task.status='cancelled' THEN 'cancelled' ELSE 'lease_lost' END,
                usage_completeness='unknown', finished_at=clock_timestamp()
           FROM learning_tasks task
          WHERE attempt.task_id=task.id AND attempt.outcome='running'
            AND (task.status IN ('succeeded','failed','cancelled')
                 OR task.lease_epoch<>attempt.lease_epoch)
            AND attempt.started_at<=clock_timestamp()-$1*interval '1 millisecond'`,
        [this.config.leaseMs],
      );
      return rows.rows.length;
    });
  }

  /** End tasks that waited in the queue past the shared queue deadline. */
  async expireQueued(): Promise<number> {
    return this.transaction(async (q) => {
      const result = await q.query<{ id: string }>(
        `UPDATE learning_tasks
            SET status='failed', last_error_code='QUEUE_WAIT_EXPIRED',
                finished_at=clock_timestamp(), state_version=state_version+1,
                updated_at=clock_timestamp()
          WHERE id IN (
            SELECT id FROM learning_tasks
             WHERE status='queued'
               AND updated_at<=clock_timestamp()-$1*interval '1 millisecond'
             LIMIT 20 FOR UPDATE SKIP LOCKED
          )
          RETURNING id`,
        [this.config.queueWaitMs],
      );
      return result.rows.length;
    });
  }

  /** Publish this process as a live (or draining) learning-task worker. */
  async workerHeartbeat(workerId: string, draining = false): Promise<void> {
    await this.transaction((q) =>
      q.query(
        `INSERT INTO generation_worker_heartbeats(worker_id,pipeline_versions,draining)
         VALUES($1,$2::jsonb,$3)
         ON CONFLICT(worker_id) DO UPDATE SET pipeline_versions=EXCLUDED.pipeline_versions,
           heartbeat_at=clock_timestamp(), draining=EXCLUDED.draining`,
        [
          learningWorkerHeartbeatId(workerId),
          JSON.stringify([LEARNING_TASK_WORKER_CAPABILITY]),
          draining,
        ],
      ),
    );
  }
}

/** Learning runners heartbeat under their own row so generation counts are unchanged. */
export function learningWorkerHeartbeatId(workerId: string): string {
  return `${workerId}#learning`;
}

/** Whether a non-draining worker that runs learning tasks heartbeated recently. */
export async function isLearningTaskWorkerLive(q: Queryable): Promise<boolean> {
  try {
    if (isHostedAuthEnabled()) {
      const result = await q.query<{ worker_live: boolean }>(
        'SELECT worker_live FROM app_internal.learning_task_readiness()',
      );
      return result.rows[0]?.worker_live === true;
    }
    const result = await q.query<{ live: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM generation_worker_heartbeats
         WHERE heartbeat_at > clock_timestamp() - interval '30 seconds' AND NOT draining
           AND pipeline_versions @> $1::jsonb) AS live`,
      [JSON.stringify([LEARNING_TASK_WORKER_CAPABILITY])],
    );
    return result.rows[0]?.live === true;
  } catch {
    return false;
  }
}
