/**
 * Storage of explanations on request (learning plan B13, accounts v34).
 * Owner-bound queries only; the service decides what a request contains.
 */
import { randomBytes } from 'node:crypto';

import type { Queryable } from '@openmaic/storage/document/pg';

import { StudyError } from '@/lib/server/study/spaces/repository';
import {
  EXPLANATION_LIMITS,
  type ExplanationContent,
  type ExplanationFormat,
  type ExplanationRequest,
  type ExplanationStatus,
} from '@/lib/study/explanations/contracts';

export function createExplanationId(): string {
  return `ex-${randomBytes(9).toString('base64url')}`;
}

export interface ExplanationRow {
  id: string;
  spaceId: string;
  itemId: string;
  format: ExplanationFormat;
  status: ExplanationStatus;
  title: string | null;
  request: ExplanationRequest;
  reuseKey: string;
  content: ExplanationContent | null;
  calls: number;
  callCap: number;
  inputTokens: number;
  outputTokens: number;
  model: string | null;
  attempts: number;
  lastError: string | null;
  leaseUntil: string | null;
  jobId: string | null;
  stageId: string | null;
  requestHash: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

const COLUMNS = `id, space_id, item_id, format, status, title, request, reuse_key, content, calls,
  call_cap, input_tokens, output_tokens, model, attempts, last_error, lease_until, job_id,
  stage_id, request_hash, revision, created_at, updated_at`;

/** The list leaves the content out (an interactive page can be large). */
const SUMMARY_COLUMNS = COLUMNS.replace('content,', 'NULL::jsonb AS content,');

type Raw = Record<string, unknown>;

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function toRow(raw: Raw): ExplanationRow {
  return {
    id: String(raw.id),
    spaceId: String(raw.space_id),
    itemId: String(raw.item_id),
    format: raw.format as ExplanationFormat,
    status: raw.status as ExplanationStatus,
    title: (raw.title as string | null) ?? null,
    request: raw.request as ExplanationRequest,
    reuseKey: String(raw.reuse_key),
    content: (raw.content as ExplanationContent | null) ?? null,
    calls: Number(raw.calls),
    callCap: Number(raw.call_cap),
    inputTokens: Number(raw.input_tokens),
    outputTokens: Number(raw.output_tokens),
    model: (raw.model as string | null) ?? null,
    attempts: Number(raw.attempts),
    lastError: (raw.last_error as string | null) ?? null,
    leaseUntil: raw.lease_until ? iso(raw.lease_until) : null,
    jobId: (raw.job_id as string | null) ?? null,
    stageId: (raw.stage_id as string | null) ?? null,
    requestHash: String(raw.request_hash),
    revision: Number(raw.revision),
    createdAt: iso(raw.created_at),
    updatedAt: iso(raw.updated_at),
  };
}

export async function getExplanation(
  db: Queryable,
  ownerId: string,
  id: string,
): Promise<ExplanationRow> {
  const result = await db.query<Raw>(
    `SELECT ${COLUMNS} FROM study_explanations WHERE owner_id = $1 AND id = $2`,
    [ownerId, id],
  );
  if (!result.rows[0]) throw new StudyError('STUDY_EXPLANATION_NOT_FOUND');
  return toRow(result.rows[0]);
}

export async function findExplanationByKey(
  db: Queryable,
  ownerId: string,
  idempotencyKey: string,
): Promise<ExplanationRow | null> {
  const result = await db.query<Raw>(
    `SELECT ${COLUMNS} FROM study_explanations WHERE owner_id = $1 AND idempotency_key = $2`,
    [ownerId, idempotencyKey],
  );
  return result.rows[0] ? toRow(result.rows[0]) : null;
}

/** The newest ready explanation written from the same inputs. */
export async function findReusable(
  db: Queryable,
  ownerId: string,
  reuseKey: string,
): Promise<ExplanationRow | null> {
  const result = await db.query<Raw>(
    `SELECT ${COLUMNS} FROM study_explanations
      WHERE owner_id = $1 AND reuse_key = $2 AND status = 'ready'
      ORDER BY created_at DESC LIMIT 1`,
    [ownerId, reuseKey],
  );
  return result.rows[0] ? toRow(result.rows[0]) : null;
}

/** A course explanation of this item that is still waiting or holds a course. */
export async function findOpenCourse(
  db: Queryable,
  ownerId: string,
  itemId: string,
): Promise<ExplanationRow | null> {
  const result = await db.query<Raw>(
    `SELECT ${COLUMNS} FROM study_explanations
      WHERE owner_id = $1 AND item_id = $2 AND format = 'course'
        AND status IN ('pending', 'ready')
      ORDER BY created_at DESC LIMIT 1`,
    [ownerId, itemId],
  );
  return result.rows[0] ? toRow(result.rows[0]) : null;
}

export async function listExplanationRows(
  db: Queryable,
  ownerId: string,
  filter: { spaceId: string; itemId?: string },
): Promise<ExplanationRow[]> {
  const result = await db.query<Raw>(
    `SELECT ${SUMMARY_COLUMNS} FROM study_explanations
      WHERE owner_id = $1 AND space_id = $2 AND ($3::text IS NULL OR item_id = $3)
      ORDER BY created_at DESC
      LIMIT 100`,
    [ownerId, filter.spaceId, filter.itemId ?? null],
  );
  return result.rows.map(toRow);
}

/** Model explanations started in the last day (courses are counted by course generation). */
export async function countStartedToday(db: Queryable, ownerId: string): Promise<number> {
  const result = await db.query<{ n: string | number }>(
    `SELECT count(*) AS n FROM study_explanations
      WHERE owner_id = $1 AND format <> 'course'
        AND created_at > clock_timestamp() - interval '1 day'`,
    [ownerId],
  );
  return Number(result.rows[0]?.n ?? 0);
}

export async function insertExplanation(
  db: Queryable,
  ownerId: string,
  input: {
    id: string;
    spaceId: string;
    itemId: string;
    format: ExplanationFormat;
    request: ExplanationRequest;
    reuseKey: string;
    idempotencyKey: string;
    requestHash: string;
  },
): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO study_explanations
       (owner_id, id, space_id, item_id, format, request, reuse_key, call_cap,
        idempotency_key, request_hash)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
     ON CONFLICT (owner_id, idempotency_key) DO NOTHING
     RETURNING id`,
    [
      ownerId,
      input.id,
      input.spaceId,
      input.itemId,
      input.format,
      JSON.stringify(input.request),
      input.reuseKey,
      EXPLANATION_LIMITS.callCap[input.format],
      input.idempotencyKey,
      input.requestHash,
    ],
  );
  return result.rows.length === 1;
}

/** Take the run of a pending explanation; null when it is not pending or another request runs it. */
export async function claimExplanation(
  db: Queryable,
  ownerId: string,
  id: string,
): Promise<{ row: ExplanationRow; token: string } | null> {
  const token = randomBytes(12).toString('base64url');
  const result = await db.query<Raw>(
    `UPDATE study_explanations
        SET lease_token = $3,
            lease_until = clock_timestamp() + ($4::int * interval '1 millisecond'),
            updated_at = clock_timestamp()
      WHERE owner_id = $1 AND id = $2 AND status = 'pending' AND format <> 'course'
        AND (lease_until IS NULL OR lease_until < clock_timestamp())
      RETURNING ${COLUMNS}`,
    [ownerId, id, token, EXPLANATION_LIMITS.leaseMs],
  );
  return result.rows[0] ? { row: toRow(result.rows[0]), token } : null;
}

export interface RunUpdate {
  status: 'ready' | 'failed';
  title: string | null;
  content: ExplanationContent | null;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  model: string;
  lastError: string | null;
}

/**
 * Store what a run produced — only while it still holds the lease and the
 * explanation is pending (a cancel in between keeps it cancelled).
 */
export async function finishExplanation(
  db: Queryable,
  ownerId: string,
  id: string,
  token: string,
  update: RunUpdate,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE study_explanations
        SET status = $4, title = $5, content = $6::jsonb, calls = calls + $7,
            input_tokens = input_tokens + $8, output_tokens = output_tokens + $9, model = $10,
            last_error = $11, lease_token = NULL, lease_until = NULL,
            revision = revision + 1, updated_at = clock_timestamp()
      WHERE owner_id = $1 AND id = $2 AND lease_token = $3 AND status = 'pending'
      RETURNING id`,
    [
      ownerId,
      id,
      token,
      update.status,
      update.title,
      update.content === null ? null : JSON.stringify(update.content),
      update.calls,
      update.inputTokens,
      update.outputTokens,
      update.model.slice(0, 160),
      update.lastError,
    ],
  );
  return result.rows.length === 1;
}

/** Move the status when it is one of `from`; null when it was not. */
export async function setExplanationStatus(
  db: Queryable,
  ownerId: string,
  id: string,
  from: readonly ExplanationStatus[],
  to: ExplanationStatus,
  extra: { attempts?: number; lastError?: string | null; jobId?: string | null } = {},
): Promise<ExplanationRow | null> {
  const result = await db.query<Raw>(
    `UPDATE study_explanations
        SET status = $4,
            attempts = COALESCE($5, attempts),
            last_error = CASE WHEN $6::boolean THEN $7 ELSE last_error END,
            job_id = CASE WHEN $8::boolean THEN $9 ELSE job_id END,
            lease_token = NULL, lease_until = NULL,
            revision = revision + 1, updated_at = clock_timestamp()
      WHERE owner_id = $1 AND id = $2 AND status = ANY($3::text[])
      RETURNING ${COLUMNS}`,
    [
      ownerId,
      id,
      [...from],
      to,
      extra.attempts ?? null,
      'lastError' in extra,
      extra.lastError ?? null,
      'jobId' in extra,
      extra.jobId ?? null,
    ],
  );
  return result.rows[0] ? toRow(result.rows[0]) : null;
}

/** Record the course generation job of a course explanation (no course yet). */
export async function setCourseJob(
  db: Queryable,
  ownerId: string,
  id: string,
  jobId: string,
): Promise<ExplanationRow | null> {
  const result = await db.query<Raw>(
    `UPDATE study_explanations
        SET job_id = $3, status = 'pending', last_error = NULL,
            revision = revision + 1, updated_at = clock_timestamp()
      WHERE owner_id = $1 AND id = $2 AND format = 'course' AND stage_id IS NULL
        AND status IN ('pending', 'failed', 'cancelled')
      RETURNING ${COLUMNS}`,
    [ownerId, id, jobId],
  );
  return result.rows[0] ? toRow(result.rows[0]) : null;
}

/** Record the course of a course explanation (in the caller's transaction). */
export async function setCourseStage(
  tx: Queryable,
  ownerId: string,
  id: string,
  stageId: string,
): Promise<void> {
  await tx.query(
    `UPDATE study_explanations
        SET stage_id = $3, status = 'ready', last_error = NULL,
            revision = revision + 1, updated_at = clock_timestamp()
      WHERE owner_id = $1 AND id = $2 AND format = 'course'`,
    [ownerId, id, stageId],
  );
}

export async function lockExplanation(
  tx: Queryable,
  ownerId: string,
  id: string,
): Promise<ExplanationRow> {
  const result = await tx.query<Raw>(
    `SELECT ${COLUMNS} FROM study_explanations WHERE owner_id = $1 AND id = $2 FOR UPDATE`,
    [ownerId, id],
  );
  if (!result.rows[0]) throw new StudyError('STUDY_EXPLANATION_NOT_FOUND');
  return toRow(result.rows[0]);
}

export async function deleteExplanationRow(
  db: Queryable,
  ownerId: string,
  id: string,
): Promise<boolean> {
  const result = await db.query(
    'DELETE FROM study_explanations WHERE owner_id = $1 AND id = $2 RETURNING id',
    [ownerId, id],
  );
  return result.rows.length === 1;
}
