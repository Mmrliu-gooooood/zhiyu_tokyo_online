/**
 * Durable lease-queue mechanics shared by the PostgreSQL task queues
 * (generation_jobs and learning_tasks).
 *
 * Each queue keeps its own table and contract; only the parts that must stay
 * identical live here: one-transaction helpers, the claim-time account fence,
 * heavy-task admission plus fairness under the global admission lock, retry
 * backoff and the bounded error summary that may reach the database.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import type { TransactionSource } from '@/lib/persistence/owner-bound-document-store';
import { isHostedAuthEnabled } from '@/lib/auth/mode';
import {
  checkHeavyTaskAdmission,
  isHeavyTaskFairTurn,
  type HeavyTaskKind,
} from '@/lib/server/heavy-task-admission';

/** Run `body` in one BEGIN/COMMIT on a checked-out client; roll back on any error. */
export async function runQueueTransaction<T>(
  pool: TransactionSource,
  body: (q: Queryable) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  const q: Queryable = {
    async query<R extends Record<string, unknown>>(sql: string, p?: unknown[]) {
      const r = await c.query(sql, p);
      return { rows: r.rows as R[] };
    },
  };
  try {
    await c.query('BEGIN');
    const result = await body(q);
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

/** Bounded, secret-free failure text for durable rows and events. */
export function sanitizeTaskErrorSummary(value: string | undefined): string | null {
  if (!value) return null;
  const compact = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/https?:\/\/\S+/gi, '[redacted-url]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted-key]')
    .replace(/\s+/g, ' ')
    .trim();
  return compact ? compact.slice(0, 240) : null;
}

/** Only fixed upper-case codes reach durable rows; anything else maps to `fallback`. */
export function safeTaskErrorCode(code: string, fallback: string): string {
  return /^[A-Z0-9_]{1,100}$/.test(code) ? code : fallback;
}

/**
 * Exponential retry delay with jitter: 2s, 4s, 8s … capped at 60s, never
 * shorter than a provider's explicit Retry-After.
 */
export function taskRetryDelayMs(
  attemptCount: number,
  retryAfterMs = 0,
  random: () => number = Math.random,
): number {
  return Math.max(
    retryAfterMs,
    Math.min(60_000, 2000 * 2 ** Math.max(0, attemptCount - 1)) + Math.floor(random() * 1000),
  );
}

/** Serializes every queue's candidate selection with the heavy-task admission seam. */
export async function lockHeavyTaskAdmission(q: Queryable): Promise<void> {
  await q.query("SELECT pg_advisory_xact_lock(hashtext('heavy-task:admission:v1'))");
}

/**
 * Claim-time account fence for a candidate row alias: hosted accounts must be
 * active and not tombstoned; cancellation requests always exclude a row.
 */
export function claimAccountFenceSql(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error('invalid claim alias');
  return isHostedAuthEnabled()
    ? `AND ${alias}.cancel_requested_at IS NULL
           AND EXISTS (
             SELECT 1 FROM app_accounts account
              WHERE account.owner_id=${alias}.owner_id AND account.status='active'
           )
           AND NOT EXISTS (
             SELECT 1 FROM deleted_account_tombstones tombstone
              WHERE tombstone.owner_id=${alias}.owner_id
           )`
    : `AND ${alias}.cancel_requested_at IS NULL`;
}

/** Non-blocking per-owner claim lock so one owner's claim never waits on another worker. */
export async function tryLockClaimOwner(
  q: Queryable,
  namespace: string,
  ownerId: string,
): Promise<boolean> {
  const lock = await q.query<{ locked: boolean }>(
    `SELECT pg_try_advisory_xact_lock(hashtext($1 || $2)) AS locked`,
    [`${namespace}:owner:`, ownerId],
  );
  return lock.rows[0]?.locked === true;
}

export interface HeavyTaskClaimRoot {
  ownerId: string;
  rootTaskId: string;
  kind: HeavyTaskKind;
  agentLeaseTtlMs: number;
}

/**
 * Admit one durable root at claim time: personal/site concurrency first, then
 * FIFO fairness across every heavy queue unless the root already holds a slot.
 * The caller holds the admission lock and changes the row to running in the
 * same transaction.
 */
export async function admitHeavyTaskClaim(
  q: Queryable,
  root: HeavyTaskClaimRoot,
): Promise<boolean> {
  const admission = await checkHeavyTaskAdmission(q, root);
  if (!admission.allowed) return false;
  if (admission.inherited) return true;
  return isHeavyTaskFairTurn(q, root);
}
