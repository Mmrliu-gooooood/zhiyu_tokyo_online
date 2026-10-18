/**
 * Practice jobs repository (accounts v32, learning plan B11). Every query
 * names the owner explicitly; on hosted databases web also runs owner-bound
 * under app_web.
 *
 * - Creating a job is one insert keyed by the client's idempotency key: a
 *   retry returns the same job, the same key with a different request is a
 *   conflict.
 * - A step claims the job with a lease token (only `pending` jobs whose lease
 *   is free or expired); finishing re-locks the row by that token, so a step
 *   that lost its lease, or a job cancelled meanwhile, stores nothing.
 */
import { randomBytes } from 'node:crypto';

import type { Queryable } from '@openmaic/storage/document/pg';

import { StudyError } from '@/lib/server/study/spaces/repository';
import {
  PRACTICE_LIMITS,
  type PracticeEvidence,
  type PracticeJobKind,
  type PracticeJobRequest,
  type PracticeJobStatus,
  type ProducedQuestion,
  type RejectedQuestion,
} from '@/lib/study/practice/contracts';

function iso(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function json<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

export function createPracticeJobId(): string {
  return `pj-${randomBytes(9).toString('base64url')}`;
}

export interface PracticeJobRow {
  id: string;
  spaceId: string;
  kind: PracticeJobKind;
  status: PracticeJobStatus;
  request: PracticeJobRequest;
  evidence: PracticeEvidence[];
  produced: ProducedQuestion[];
  rejected: RejectedQuestion[];
  requestHash: string;
  calls: number;
  callCap: number;
  continues: number;
  inputTokens: number;
  outputTokens: number;
  usageKnown: boolean;
  models: string[];
  lastError: string | null;
  leaseToken: string | null;
  leaseUntil: string | null;
  steps: number;
  paperId: string | null;
  createdAt: string;
  updatedAt: string;
}

const COLUMNS = `id, space_id, kind, status, request, evidence, produced, rejected, request_hash,
  calls, call_cap, continues, input_tokens, output_tokens, usage_known, models, last_error,
  lease_token, lease_until, steps, paper_id, created_at, updated_at`;

function toRow(row: Record<string, unknown>): PracticeJobRow {
  return {
    id: String(row.id),
    spaceId: String(row.space_id),
    kind: row.kind as PracticeJobKind,
    status: row.status as PracticeJobStatus,
    request: json<PracticeJobRequest>(row.request)!,
    evidence: json<PracticeEvidence[]>(row.evidence) ?? [],
    produced: json<ProducedQuestion[]>(row.produced) ?? [],
    rejected: json<RejectedQuestion[]>(row.rejected) ?? [],
    requestHash: String(row.request_hash),
    calls: Number(row.calls),
    callCap: Number(row.call_cap),
    continues: Number(row.continues),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    usageKnown: row.usage_known === true,
    models: Array.isArray(row.models) ? (row.models as string[]) : [],
    lastError: (row.last_error as string | null) ?? null,
    leaseToken: (row.lease_token as string | null) ?? null,
    leaseUntil: row.lease_until ? iso(row.lease_until as string | Date) : null,
    steps: Number(row.steps),
    paperId: (row.paper_id as string | null) ?? null,
    createdAt: iso(row.created_at as string | Date),
    updatedAt: iso(row.updated_at as string | Date),
  };
}

export async function getPracticeJob(
  db: Queryable,
  ownerId: string,
  jobId: string,
  options: { forUpdate?: boolean } = {},
): Promise<PracticeJobRow> {
  const result = await db.query(
    `SELECT ${COLUMNS} FROM study_practice_jobs WHERE owner_id = $1 AND id = $2${
      options.forUpdate ? ' FOR UPDATE' : ''
    }`,
    [ownerId, jobId],
  );
  const row = result.rows[0];
  if (!row) throw new StudyError('STUDY_PRACTICE_JOB_NOT_FOUND');
  return toRow(row);
}

export async function findPracticeJobByKey(
  db: Queryable,
  ownerId: string,
  idempotencyKey: string,
): Promise<PracticeJobRow | null> {
  const result = await db.query(
    `SELECT ${COLUMNS} FROM study_practice_jobs WHERE owner_id = $1 AND idempotency_key = $2`,
    [ownerId, idempotencyKey],
  );
  return result.rows[0] ? toRow(result.rows[0]) : null;
}

/** Jobs the student started in the last 24 hours (all spaces). */
export async function recentPracticeJobs(db: Queryable, ownerId: string): Promise<number> {
  const result = await db.query<{ n: string | number }>(
    `SELECT count(*) AS n FROM study_practice_jobs
      WHERE owner_id = $1 AND created_at > clock_timestamp() - interval '1 day'`,
    [ownerId],
  );
  return Number(result.rows[0]?.n ?? 0);
}

export interface NewPracticeJob {
  id: string;
  spaceId: string;
  kind: PracticeJobKind;
  request: PracticeJobRequest;
  evidence: PracticeEvidence[];
  requestHash: string;
  idempotencyKey: string;
  callCap: number;
}

/** Insert a job; false when the idempotency key was taken meanwhile. */
export async function insertPracticeJob(
  db: Queryable,
  ownerId: string,
  job: NewPracticeJob,
): Promise<boolean> {
  const inserted = await db.query(
    `INSERT INTO study_practice_jobs
       (owner_id, id, space_id, kind, request, evidence, request_hash, idempotency_key, call_cap)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)
     ON CONFLICT (owner_id, idempotency_key) DO NOTHING
     RETURNING id`,
    [
      ownerId,
      job.id,
      job.spaceId,
      job.kind,
      JSON.stringify(job.request),
      JSON.stringify(job.evidence),
      job.requestHash,
      job.idempotencyKey,
      job.callCap,
    ],
  );
  return inserted.rows.length > 0;
}

/** Claim the next step of a pending job; null when it is not pending or another step holds it. */
export async function claimPracticeStep(
  db: Queryable,
  ownerId: string,
  jobId: string,
): Promise<{ job: PracticeJobRow; token: string } | null> {
  const token = randomBytes(12).toString('base64url');
  const result = await db.query(
    `UPDATE study_practice_jobs
        SET lease_token = $3,
            lease_until = clock_timestamp() + ($4::int * interval '1 millisecond'),
            steps = steps + 1, updated_at = clock_timestamp()
      WHERE owner_id = $1 AND id = $2 AND status = 'pending'
        AND (lease_until IS NULL OR lease_until < clock_timestamp())
      RETURNING ${COLUMNS}`,
    [ownerId, jobId, token, PRACTICE_LIMITS.stepLeaseMs],
  );
  return result.rows[0] ? { job: toRow(result.rows[0]), token } : null;
}

/** Lock the job for finishing a step; null when the lease was lost or the job was cancelled. */
export async function lockClaimedJob(
  tx: Queryable,
  ownerId: string,
  jobId: string,
  token: string,
): Promise<PracticeJobRow | null> {
  const result = await tx.query(
    `SELECT ${COLUMNS} FROM study_practice_jobs
      WHERE owner_id = $1 AND id = $2 AND lease_token = $3 AND status = 'pending'
      FOR UPDATE`,
    [ownerId, jobId, token],
  );
  return result.rows[0] ? toRow(result.rows[0]) : null;
}

export interface StepUpdate {
  status: PracticeJobStatus;
  produced: ProducedQuestion[];
  rejected: RejectedQuestion[];
  calls: number;
  inputTokens: number;
  outputTokens: number;
  usageKnown: boolean;
  models: string[];
  lastError: string | null;
}

/** Store a finished step (the row is locked by lockClaimedJob) and free the lease. */
export async function finishPracticeStep(
  tx: Queryable,
  ownerId: string,
  jobId: string,
  update: StepUpdate,
): Promise<void> {
  await tx.query(
    `UPDATE study_practice_jobs
        SET status = $3, produced = $4::jsonb, rejected = $5::jsonb, calls = $6,
            input_tokens = $7, output_tokens = $8, usage_known = $9, models = $10::text[],
            last_error = $11, lease_token = NULL, lease_until = NULL,
            updated_at = clock_timestamp()
      WHERE owner_id = $1 AND id = $2`,
    [
      ownerId,
      jobId,
      update.status,
      JSON.stringify(update.produced),
      JSON.stringify(update.rejected.slice(-PRACTICE_LIMITS.rejectedKept)),
      update.calls,
      update.inputTokens,
      update.outputTokens,
      update.usageKnown,
      update.models.slice(-6),
      update.lastError,
    ],
  );
}

/** Stop or cancel without a running step (the lease, if any, is dropped). */
export async function setPracticeStatus(
  db: Queryable,
  ownerId: string,
  jobId: string,
  from: readonly PracticeJobStatus[],
  to: PracticeJobStatus,
  extra: { callCap?: number; continues?: number; lastError?: string | null } = {},
): Promise<PracticeJobRow | null> {
  const result = await db.query(
    `UPDATE study_practice_jobs
        SET status = $4,
            call_cap = COALESCE($5::smallint, call_cap),
            continues = COALESCE($6::smallint, continues),
            last_error = CASE WHEN $7::boolean THEN $8 ELSE last_error END,
            lease_token = NULL, lease_until = NULL, updated_at = clock_timestamp()
      WHERE owner_id = $1 AND id = $2 AND status = ANY($3::text[]) AND paper_id IS NULL
      RETURNING ${COLUMNS}`,
    [
      ownerId,
      jobId,
      [...from],
      to,
      extra.callCap ?? null,
      extra.continues ?? null,
      extra.lastError !== undefined,
      extra.lastError ?? null,
    ],
  );
  return result.rows[0] ? toRow(result.rows[0]) : null;
}

/** Record the paper a job fed; false when another request already published it. */
export async function markJobPublished(
  tx: Queryable,
  ownerId: string,
  jobId: string,
  paperId: string,
): Promise<boolean> {
  const result = await tx.query(
    `UPDATE study_practice_jobs SET paper_id = $3, updated_at = clock_timestamp()
      WHERE owner_id = $1 AND id = $2 AND paper_id IS NULL
      RETURNING id`,
    [ownerId, jobId, paperId],
  );
  return result.rows.length > 0;
}
