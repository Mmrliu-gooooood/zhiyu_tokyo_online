/**
 * Grading records of open items (accounts v30, learning plan B09). Every
 * query names the owner explicitly; on hosted databases web also runs
 * owner-bound under app_web.
 *
 * - Submitting an attempt creates one `auto` row per answered open item.
 * - A row is claimed before the model is called: a single conditional update
 *   from pending/failed (or a running row whose lease ran out) to running,
 *   counting the try. Only the request that claimed it may finish it (same
 *   try number), so a repeated or concurrent request never grades a row
 *   twice and never overwrites a newer claim.
 * - Succeeded rows are final (the update policy no longer matches them); a
 *   review is a new row, so earlier results stay readable.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import { StudyError } from '@/lib/server/study/spaces/repository';
import type {
  AttemptGrading,
  GradingKind,
  GradingResult,
  GradingStatus,
  ItemGradingView,
} from '@/lib/study/assessments/contracts';
import { OPEN_GRADING_LIMITS } from '@/lib/study/assessments/open-grading';

/** How long a claimed grading may run before another request may take it over. */
export const GRADING_LEASE_SECONDS = 180;

function iso(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function json<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

interface GradingRow extends Record<string, unknown> {
  position: number;
  seq: number;
  kind: GradingKind;
  status: GradingStatus;
  points: number;
  earned: number | null;
  result: unknown;
  grader: unknown;
  note: string | null;
  error: string | null;
  created_at: string | Date;
  completed_at: string | Date | null;
}

function toView(row: GradingRow): ItemGradingView {
  return {
    seq: Number(row.seq),
    kind: row.kind,
    status: row.status,
    earned: row.earned === null ? null : Number(row.earned),
    points: Number(row.points),
    result: json<GradingResult>(row.result),
    grader: json<ItemGradingView['grader']>(row.grader),
    error: row.error,
    note: row.note,
    createdAt: iso(row.created_at),
    completedAt: row.completed_at ? iso(row.completed_at) : null,
  };
}

/** Every grading of an attempt, by item position, oldest first. */
export async function listAttemptGradings(
  db: Queryable,
  ownerId: string,
  attemptId: string,
): Promise<Map<number, ItemGradingView[]>> {
  const result = await db.query<GradingRow>(
    `SELECT position, seq, kind, status, points, earned, result, grader, note, error,
            created_at, completed_at
       FROM study_exam_gradings
      WHERE owner_id = $1 AND attempt_id = $2
      ORDER BY position, seq`,
    [ownerId, attemptId],
  );
  const map = new Map<number, ItemGradingView[]>();
  for (const row of result.rows) {
    const position = Number(row.position);
    map.set(position, [...(map.get(position) ?? []), toView(row)]);
  }
  return map;
}

/** One pending `auto` row per answered open item (inside the submitting transaction). */
export async function insertSubmissionGradings(
  tx: Queryable,
  ownerId: string,
  attemptId: string,
  grading: AttemptGrading,
): Promise<void> {
  const pending = grading.items.filter((item) => item.outcome === 'pending');
  if (pending.length === 0) return;
  await tx.query(
    `INSERT INTO study_exam_gradings (owner_id, attempt_id, position, seq, kind, status, points)
     SELECT $1, $2, p.position, 1, 'auto', 'pending', p.points
       FROM unnest($3::int[], $4::int[]) AS p(position, points)
     ON CONFLICT DO NOTHING`,
    [ownerId, attemptId, pending.map((item) => item.position), pending.map((item) => item.points)],
  );
}

/**
 * Points earned so far by the open items of submitted attempts, and how many
 * still have no score (waiting, running or failed): the latest succeeded
 * grading by the grader (not the student's own) counts.
 */
export async function openItemTotals(
  db: Queryable,
  ownerId: string,
  attempts: ReadonlyArray<{ attemptId: string; grading: AttemptGrading | null }>,
): Promise<Map<string, { earned: number; ungraded: number; correct: number }>> {
  const totals = new Map<string, { earned: number; ungraded: number; correct: number }>();
  const open = attempts.filter((attempt) => attempt.grading?.version === 'mixed-v1');
  for (const attempt of attempts)
    totals.set(attempt.attemptId, { earned: 0, ungraded: 0, correct: 0 });
  if (open.length === 0) return totals;
  const result = await db.query<{
    attempt_id: string;
    position: number;
    earned: number;
    points: number;
  }>(
    `SELECT DISTINCT ON (attempt_id, position) attempt_id, position, earned, points
       FROM study_exam_gradings
      WHERE owner_id = $1 AND attempt_id = ANY($2::text[])
        AND kind <> 'self' AND status = 'succeeded'
      ORDER BY attempt_id, position, seq DESC`,
    [ownerId, open.map((attempt) => attempt.attemptId)],
  );
  const scored = new Map<string, Map<number, { earned: number; points: number }>>();
  for (const row of result.rows) {
    const byPosition = scored.get(row.attempt_id) ?? new Map();
    byPosition.set(Number(row.position), {
      earned: Number(row.earned),
      points: Number(row.points),
    });
    scored.set(row.attempt_id, byPosition);
  }
  for (const attempt of open) {
    const byPosition = scored.get(attempt.attemptId) ?? new Map();
    const total = { earned: 0, ungraded: 0, correct: 0 };
    for (const item of attempt.grading!.items) {
      if (item.outcome !== 'pending') continue;
      const score = byPosition.get(item.position);
      if (!score) {
        total.ungraded += 1;
        continue;
      }
      total.earned += score.earned;
      if (score.earned >= score.points) total.correct += 1;
    }
    totals.set(attempt.attemptId, total);
  }
  return totals;
}

export interface ClaimedGrading {
  position: number;
  seq: number;
  kind: GradingKind;
  points: number;
  tries: number;
}

/**
 * Claim the next grading to run: the given item's latest official row, or
 * else the first waiting row. Failed rows are only taken when named (the
 * student retries them); a running row only once its lease ran out.
 */
export async function claimGrading(
  db: Queryable,
  ownerId: string,
  attemptId: string,
  position: number | null,
): Promise<ClaimedGrading | null> {
  const result = await db.query<{
    position: number;
    seq: number;
    kind: GradingKind;
    points: number;
    tries: number;
  }>(
    `UPDATE study_exam_gradings g
        SET status = 'running', tries = g.tries + 1, error = NULL,
            lease_until = clock_timestamp() + make_interval(secs => $4),
            updated_at = clock_timestamp()
       FROM (
         SELECT position, seq FROM study_exam_gradings
          WHERE owner_id = $1 AND attempt_id = $2 AND kind <> 'self'
            AND ($3::int IS NULL OR position = $3)
            AND tries < $5
            AND (
              status = 'pending'
              OR ($3::int IS NOT NULL AND status = 'failed')
              OR (status = 'running' AND lease_until < clock_timestamp())
            )
            AND seq = (
              SELECT max(seq) FROM study_exam_gradings latest
               WHERE latest.owner_id = $1 AND latest.attempt_id = $2
                 AND latest.position = study_exam_gradings.position AND latest.kind <> 'self'
            )
          ORDER BY position
          LIMIT 1
       ) next
      WHERE g.owner_id = $1 AND g.attempt_id = $2
        AND g.position = next.position AND g.seq = next.seq
        -- Re-checked after waiting on a concurrent claim of the same row.
        AND g.tries < $5
        AND (
          g.status = 'pending'
          OR ($3::int IS NOT NULL AND g.status = 'failed')
          OR (g.status = 'running' AND g.lease_until < clock_timestamp())
        )
      RETURNING g.position, g.seq, g.kind, g.points, g.tries`,
    [ownerId, attemptId, position, GRADING_LEASE_SECONDS, OPEN_GRADING_LIMITS.triesPerGrading],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    position: Number(row.position),
    seq: Number(row.seq),
    kind: row.kind,
    points: Number(row.points),
    tries: Number(row.tries),
  };
}

export interface GradingUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  known: boolean;
}

/** Store the outcome of a claimed grading. False when the claim was lost meanwhile. */
export async function finishGrading(
  db: Queryable,
  ownerId: string,
  attemptId: string,
  claim: ClaimedGrading,
  outcome:
    | {
        status: 'succeeded';
        earned: number;
        result: GradingResult;
        grader: NonNullable<ItemGradingView['grader']>;
        usage: GradingUsage;
      }
    | { status: 'failed'; error: string; grader: ItemGradingView['grader']; usage: GradingUsage },
): Promise<boolean> {
  const succeeded = outcome.status === 'succeeded';
  const result = await db.query(
    `UPDATE study_exam_gradings
        SET status = $6, earned = $7, result = $8::jsonb, grader = $9::jsonb, error = $10,
            usage = jsonb_build_object(
              'calls', COALESCE((usage->>'calls')::int, 0) + $11,
              'inputTokens', COALESCE((usage->>'inputTokens')::int, 0) + $12,
              'outputTokens', COALESCE((usage->>'outputTokens')::int, 0) + $13,
              'known', COALESCE((usage->>'known')::boolean, true) AND $14
            ),
            lease_until = NULL, updated_at = clock_timestamp(),
            completed_at = CASE WHEN $6 = 'succeeded' THEN clock_timestamp() ELSE NULL END
      WHERE owner_id = $1 AND attempt_id = $2 AND position = $3 AND seq = $4
        AND status = 'running' AND tries = $5
      RETURNING seq`,
    [
      ownerId,
      attemptId,
      claim.position,
      claim.seq,
      claim.tries,
      outcome.status,
      succeeded ? outcome.earned : null,
      succeeded ? JSON.stringify(outcome.result) : null,
      outcome.grader ? JSON.stringify(outcome.grader) : null,
      succeeded ? null : outcome.error.slice(0, 80),
      outcome.usage.calls,
      outcome.usage.inputTokens,
      outcome.usage.outputTokens,
      outcome.usage.known,
    ],
  );
  return result.rows.length > 0;
}

async function itemRows(
  tx: Queryable,
  ownerId: string,
  attemptId: string,
  position: number,
): Promise<Array<{ seq: number; kind: GradingKind; status: GradingStatus; points: number }>> {
  const result = await tx.query<{
    seq: number;
    kind: GradingKind;
    status: GradingStatus;
    points: number;
  }>(
    `SELECT seq, kind, status, points FROM study_exam_gradings
      WHERE owner_id = $1 AND attempt_id = $2 AND position = $3
      ORDER BY seq`,
    [ownerId, attemptId, position],
  );
  return result.rows.map((row) => ({
    seq: Number(row.seq),
    kind: row.kind,
    status: row.status,
    points: Number(row.points),
  }));
}

/**
 * Ask for another grading of an item (the earlier ones stay). Only once the
 * latest official grading has finished, and a few times per item.
 */
export async function addReview(
  tx: Queryable,
  ownerId: string,
  attemptId: string,
  position: number,
): Promise<{ seq: number }> {
  // Serialize per attempt: two clicks must not create two reviews.
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 30))`, [
    `${ownerId}/${attemptId}/${position}`,
  ]);
  const rows = await itemRows(tx, ownerId, attemptId, position);
  const official = rows.filter((row) => row.kind !== 'self');
  if (official.length === 0) throw new StudyError('STUDY_GRADING_NOT_FOUND');
  const latest = official[official.length - 1]!;
  if (latest.status !== 'succeeded') {
    throw new StudyError('STUDY_GRADING_BUSY', { status: latest.status });
  }
  if (
    rows.filter((row) => row.kind === 'review').length >= OPEN_GRADING_LIMITS.reviewsPerItem ||
    rows.length >= OPEN_GRADING_LIMITS.recordsPerItem
  ) {
    throw new StudyError('STUDY_GRADING_LIMIT');
  }
  const seq = Math.max(...rows.map((row) => row.seq)) + 1;
  await tx.query(
    `INSERT INTO study_exam_gradings (owner_id, attempt_id, position, seq, kind, status, points)
     VALUES ($1, $2, $3, $4, 'review', 'pending', $5)`,
    [ownerId, attemptId, position, seq, latest.points],
  );
  return { seq };
}

/** The student's own score for an item, kept apart from the graded one. */
export async function addSelfGrade(
  tx: Queryable,
  ownerId: string,
  attemptId: string,
  position: number,
  input: { earned: number; note: string | null },
): Promise<{ seq: number }> {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 30))`, [
    `${ownerId}/${attemptId}/${position}`,
  ]);
  const rows = await itemRows(tx, ownerId, attemptId, position);
  if (rows.length === 0) throw new StudyError('STUDY_GRADING_NOT_FOUND');
  const points = rows[0]!.points;
  if (!Number.isInteger(input.earned) || input.earned < 0 || input.earned > points) {
    throw new StudyError('STUDY_GRADING_INVALID', { field: 'earned' });
  }
  if (rows.length >= OPEN_GRADING_LIMITS.recordsPerItem)
    throw new StudyError('STUDY_GRADING_LIMIT');
  const seq = Math.max(...rows.map((row) => row.seq)) + 1;
  await tx.query(
    `INSERT INTO study_exam_gradings
       (owner_id, attempt_id, position, seq, kind, status, points, earned, note, completed_at)
     VALUES ($1, $2, $3, $4, 'self', 'succeeded', $5, $6, $7, clock_timestamp())`,
    [ownerId, attemptId, position, seq, points, input.earned, input.note],
  );
  return { seq };
}
