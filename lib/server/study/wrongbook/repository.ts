/**
 * Wrong-answer book repository (accounts v31, learning plan B10). Every
 * query names the owner explicitly; on hosted databases web also runs
 * owner-bound under app_web.
 *
 * - Source reads are bounded: the newest submitted papers of the space and
 *   the newest classroom attempts of the space's live courses (one row per
 *   attempt: its newest record and when it was first submitted).
 * - Writes are idempotent: an occurrence is keyed by its source and only
 *   rewritten when its content digest changes.
 * - Course items are visible only while their course is a live course of the
 *   space; unlinking or deleting the course hides them (nothing is deleted).
 */
import { createHash, randomBytes } from 'node:crypto';

import type { Queryable } from '@openmaic/storage/document/pg';

import { listGradingsOfAttempts } from '@/lib/server/study/grading/repository';
import { StudyError } from '@/lib/server/study/spaces/repository';
import {
  toItemView,
  type AttemptAnswers,
  type AttemptGrading,
} from '@/lib/study/assessments/contracts';
import type { ServerQuizQuestion } from '@/lib/study/memory/projection';
import type { GradingGuide } from '@/lib/study/questions/contracts';
import {
  WRONGBOOK_LIMITS,
  cleanConcepts,
  isWrong,
  type WrongEntry,
  type WrongGrading,
  type WrongItemSummary,
  type WrongOccurrenceView,
  type WrongOrigin,
  type WrongOutcome,
  type WrongQuestion,
  type WrongResponse,
  type WrongReviewState,
  type WrongSourceType,
} from '@/lib/study/wrongbook/contracts';
import type { WrongItemRow } from '@/lib/study/wrongbook/listing';
import {
  entryFingerprint,
  type CheckSessionSource,
  type ExamAttemptSource,
  type QuizSessionSource,
} from '@/lib/study/wrongbook/projection';

function iso(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function json<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

export function createWrongItemId(): string {
  return `wi-${randomBytes(9).toString('base64url')}`;
}

export async function assertSpace(db: Queryable, ownerId: string, spaceId: string): Promise<void> {
  const result = await db.query('SELECT 1 FROM study_spaces WHERE owner_id = $1 AND id = $2', [
    ownerId,
    spaceId,
  ]);
  if (result.rows.length === 0) throw new StudyError('STUDY_SPACE_NOT_FOUND');
}

// ── sources ─────────────────────────────────────────────────────────────────

/** The space's newest submitted papers with their items, keys and gradings. */
export async function readExamSources(
  db: Queryable,
  ownerId: string,
  spaceId: string,
): Promise<ExamAttemptSource[]> {
  const attempts = await db.query<{
    id: string;
    paper_id: string;
    title: string;
    submitted_at: string | Date;
    answers: unknown;
    grading: unknown;
  }>(
    `SELECT a.id, a.paper_id, p.title, a.submitted_at, a.answers, a.grading
       FROM study_exam_attempts a
       JOIN study_exam_papers p ON p.owner_id = a.owner_id AND p.id = a.paper_id
      WHERE a.owner_id = $1 AND p.space_id = $2 AND a.status = 'submitted'
      ORDER BY a.submitted_at DESC, a.id
      LIMIT $3`,
    [ownerId, spaceId, WRONGBOOK_LIMITS.examAttempts],
  );
  if (attempts.rows.length === 0) return [];
  const paperIds = [...new Set(attempts.rows.map((row) => row.paper_id))];
  const items = await db.query<{
    paper_id: string;
    position: number;
    snapshot: unknown;
    answer_key: unknown;
    explanation: string | null;
    guide: unknown;
    question_id: string | null;
    pack_question: string | null;
    content_hash: string;
  }>(
    `SELECT paper_id, position, snapshot, answer_key, explanation, guide, question_id,
            pack_question, content_hash
       FROM study_exam_items
      WHERE owner_id = $1 AND paper_id = ANY($2::text[])
      ORDER BY paper_id, position`,
    [ownerId, paperIds],
  );
  const byPaper = new Map<string, ExamAttemptSource['items'][number][]>();
  for (const row of items.rows) {
    const view = toItemView(
      Number(row.position),
      json<Record<string, unknown>>(row.snapshot) ?? {},
    );
    const list = byPaper.get(row.paper_id) ?? [];
    list.push({
      ...view,
      answer: json<string[]>(row.answer_key) ?? [],
      explanation: row.explanation,
      guide: view.type === 'short_answer' ? json<GradingGuide>(row.guide) : null,
      questionId: row.question_id,
      packQuestion: row.pack_question,
      contentHash: row.content_hash,
    });
    byPaper.set(row.paper_id, list);
  }
  const gradings = await listGradingsOfAttempts(
    db,
    ownerId,
    attempts.rows.map((row) => row.id),
  );
  return attempts.rows.map((row) => ({
    attemptId: row.id,
    paperId: row.paper_id,
    paperTitle: row.title,
    submittedAt: iso(row.submitted_at),
    answers: json<AttemptAnswers>(row.answers) ?? {},
    grading: json<AttemptGrading>(row.grading)!,
    gradings: gradings.get(row.id) ?? new Map(),
    items: byPaper.get(row.paper_id) ?? [],
  }));
}

interface ClassroomRow extends Record<string, unknown> {
  session_id: string;
  stage_id: string;
  course_title: string | null;
  scene_id: string | null;
  first_scene_id: string | null;
  submitted_at: string | Date;
  payload: unknown;
}

/**
 * Submitted classroom attempts (quiz or learning check) in the space's live
 * courses, newest first: the newest record of each and its first submission.
 */
async function readClassroomRows(
  db: Queryable,
  ownerId: string,
  spaceId: string,
  kind: 'quizAttempt' | 'learningCheck',
): Promise<ClassroomRow[]> {
  const phase =
    kind === 'quizAttempt'
      ? `r.data->'payload'->>'phase'`
      : `r.data->'payload'->'lifecycle'->>'phase'`;
  const result = await db.query<ClassroomRow>(
    `SELECT s.id AS session_id, s.stage_id, d.name AS course_title,
            latest.scene_id, first.scene_id AS first_scene_id, first.created_at AS submitted_at,
            latest.payload
       FROM runtime_sessions s
       JOIN study_space_courses c ON c.owner_id = $1 AND c.space_id = $2 AND c.stage_id = s.stage_id
       JOIN stage_meta m ON m.stage_id = s.stage_id AND m.owner_id = $1 AND m.deleted_at IS NULL
       JOIN document_stages d ON d.id = s.stage_id
       JOIN LATERAL (
         SELECT r.seq, r.scene_id, r.created_at FROM runtime_records r
          WHERE r.session_id = s.id AND ${phase} IN ('submitted', 'reviewed')
          ORDER BY r.seq LIMIT 1
       ) first ON true
       JOIN LATERAL (
         SELECT r.scene_id, r.data->'payload' AS payload FROM runtime_records r
          WHERE r.session_id = s.id ORDER BY r.seq DESC LIMIT 1
       ) latest ON true
      WHERE s.learner_key = $1 AND s.kind = $3
      ORDER BY s.updated_at DESC, s.id
      LIMIT $4`,
    [ownerId, spaceId, kind, WRONGBOOK_LIMITS.classroomAttempts],
  );
  return result.rows.map((row) => ({
    ...row,
    payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
  }));
}

export async function readQuizSources(
  db: Queryable,
  ownerId: string,
  spaceId: string,
): Promise<QuizSessionSource[]> {
  const rows = await readClassroomRows(db, ownerId, spaceId, 'quizAttempt');
  return rows.map((row) => ({
    sessionId: row.session_id,
    stageId: row.stage_id,
    courseTitle: row.course_title ?? '',
    sceneId: row.scene_id ?? row.first_scene_id,
    submittedAt: iso(row.submitted_at),
    payload: row.payload,
  }));
}

export async function readCheckSources(
  db: Queryable,
  ownerId: string,
  spaceId: string,
): Promise<CheckSessionSource[]> {
  const rows = await readClassroomRows(db, ownerId, spaceId, 'learningCheck');
  return rows.map((row) => ({
    sessionId: row.session_id,
    stageId: row.stage_id,
    submittedAt: iso(row.submitted_at),
    payload: row.payload,
  }));
}

/** The stored course's quiz questions, keyed `stage\0scene` (re-checking classroom choice answers). */
export async function readStoredQuizQuestions(
  db: Queryable,
  keys: ReadonlyArray<{ stageId: string; sceneId: string }>,
): Promise<Map<string, ServerQuizQuestion[] | null>> {
  const map = new Map<string, ServerQuizQuestion[] | null>();
  const unique = [...new Set(keys.map((key) => `${key.stageId}\u0000${key.sceneId}`))];
  if (unique.length === 0) return map;
  const result = await db.query<{ stage_id: string; id: string; questions: unknown }>(
    `SELECT s.stage_id, s.id, s.data->'content'->'questions' AS questions
       FROM document_scenes s
       JOIN unnest($1::text[], $2::text[]) AS k(stage_id, scene_id)
         ON s.stage_id = k.stage_id AND s.id = k.scene_id`,
    [unique.map((key) => key.split('\u0000')[0]), unique.map((key) => key.split('\u0000')[1])],
  );
  for (const row of result.rows) {
    const list = typeof row.questions === 'string' ? JSON.parse(row.questions) : row.questions;
    map.set(`${row.stage_id}\u0000${row.id}`, Array.isArray(list) ? list : null);
  }
  return map;
}

// ── writes ──────────────────────────────────────────────────────────────────

interface StoredItem {
  id: string;
  concepts: string[];
  firstWrongAt: number | null;
  occurrences: number;
}

export function entryDigest(entry: WrongEntry): string {
  return createHash('sha256').update(entryFingerprint(entry)).digest('hex').slice(0, 40);
}

/**
 * Write a source's entries in time order. A wrong answer creates its item if
 * needed; a right answer is kept only for an item that already has an
 * earlier mistake. An occurrence that exists is rewritten only when its
 * content changed (and always kept, even when it is now right).
 */
export async function writeEntries(
  tx: Queryable,
  ownerId: string,
  spaceId: string,
  entries: readonly WrongEntry[],
): Promise<{ written: number; full: boolean }> {
  if (entries.length === 0) return { written: 0, full: false };
  const items = await tx.query<{
    id: string;
    question_key: string;
    concepts: string[];
    first_wrong: string | Date | null;
    occurrences: string | number;
  }>(
    `SELECT i.id, i.question_key, i.concepts,
            min(o.occurred_at) FILTER (WHERE o.outcome <> 'correct') AS first_wrong,
            count(o.source_key) AS occurrences
       FROM study_wrong_items i
       LEFT JOIN study_wrong_occurrences o ON o.owner_id = i.owner_id AND o.item_id = i.id
      WHERE i.owner_id = $1 AND i.space_id = $2
      GROUP BY i.owner_id, i.id`,
    [ownerId, spaceId],
  );
  const byKey = new Map<string, StoredItem>(
    items.rows.map((row) => [
      row.question_key,
      {
        id: row.id,
        concepts: row.concepts ?? [],
        firstWrongAt: row.first_wrong ? Date.parse(iso(row.first_wrong)) : null,
        occurrences: Number(row.occurrences),
      },
    ]),
  );
  let itemCount = items.rows.length;
  const digests = await tx.query<{ item_id: string; source_key: string; digest: string }>(
    `SELECT o.item_id, o.source_key, o.digest
       FROM study_wrong_occurrences o
       JOIN study_wrong_items i ON i.owner_id = o.owner_id AND i.id = o.item_id
      WHERE o.owner_id = $1 AND i.space_id = $2`,
    [ownerId, spaceId],
  );
  const stored = new Map(
    digests.rows.map((row) => [`${row.item_id}\u0000${row.source_key}`, row.digest]),
  );
  let written = 0;
  let full = false;
  const ordered = [...entries].sort(
    (a, b) =>
      Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.sourceKey.localeCompare(b.sourceKey),
  );
  for (const entry of ordered) {
    const wrong = isWrong(entry.outcome);
    const at = Date.parse(entry.occurredAt);
    let item = byKey.get(entry.questionKey);
    if (!item) {
      if (!wrong) continue;
      if (itemCount >= WRONGBOOK_LIMITS.itemsPerSpace) {
        full = true;
        continue;
      }
      const id = createWrongItemId();
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO study_wrong_items (owner_id, id, space_id, question_key, source_type, stage_id, concepts)
         VALUES ($1, $2, $3, $4, $5, $6, $7::text[])
         ON CONFLICT (owner_id, space_id, question_key) DO NOTHING
         RETURNING id`,
        [
          ownerId,
          id,
          spaceId,
          entry.questionKey,
          entry.sourceType,
          entry.stageId,
          entry.question.concepts,
        ],
      );
      if (inserted.rows.length === 0) {
        // Created by a concurrent sync of the same space.
        const existing = await tx.query<{ id: string; concepts: string[] }>(
          `SELECT id, concepts FROM study_wrong_items
            WHERE owner_id = $1 AND space_id = $2 AND question_key = $3`,
          [ownerId, spaceId, entry.questionKey],
        );
        item = {
          id: existing.rows[0]!.id,
          concepts: existing.rows[0]!.concepts ?? [],
          firstWrongAt: at,
          occurrences: 0,
        };
      } else {
        item = { id, concepts: entry.question.concepts, firstWrongAt: at, occurrences: 0 };
        itemCount += 1;
      }
      byKey.set(entry.questionKey, item);
    }
    const storedKey = `${item.id}\u0000${entry.sourceKey}`;
    const digest = entryDigest(entry);
    const previous = stored.get(storedKey);
    if (previous === digest) continue;
    if (previous === undefined) {
      if (!wrong && (item.firstWrongAt === null || at < item.firstWrongAt)) continue;
      if (item.occurrences >= WRONGBOOK_LIMITS.occurrencesPerItem) continue;
    }
    await tx.query(
      `INSERT INTO study_wrong_occurrences
         (owner_id, item_id, source_key, attempt_id, occurred_at, outcome, earned, points,
          question, response, grading, origin, digest)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13)
       ON CONFLICT (owner_id, item_id, source_key) DO UPDATE
         SET occurred_at = EXCLUDED.occurred_at, outcome = EXCLUDED.outcome,
             earned = EXCLUDED.earned, points = EXCLUDED.points, question = EXCLUDED.question,
             response = EXCLUDED.response, grading = EXCLUDED.grading, origin = EXCLUDED.origin,
             digest = EXCLUDED.digest, updated_at = clock_timestamp()`,
      [
        ownerId,
        item.id,
        entry.sourceKey,
        entry.attemptId,
        entry.occurredAt,
        entry.outcome,
        entry.earned,
        entry.points,
        JSON.stringify(entry.question),
        entry.response === null ? null : JSON.stringify(entry.response),
        JSON.stringify(entry.grading),
        JSON.stringify(entry.origin),
        digest,
      ],
    );
    stored.set(storedKey, digest);
    written += 1;
    if (previous === undefined) item.occurrences += 1;
    if (wrong && (item.firstWrongAt === null || at < item.firstWrongAt)) item.firstWrongAt = at;
    const concepts = cleanConcepts([...item.concepts, ...entry.question.concepts]);
    if (concepts.length !== item.concepts.length) {
      await tx.query(
        `UPDATE study_wrong_items SET concepts = $3::text[], updated_at = clock_timestamp()
          WHERE owner_id = $1 AND id = $2`,
        [ownerId, item.id, concepts],
      );
      item.concepts = concepts;
    }
  }
  return { written, full };
}

/** Clearing raw classroom quiz attempts (B06 Memory) also drops what the wrong-answer book kept of them. */
export async function deleteQuizOccurrences(tx: Queryable, ownerId: string): Promise<void> {
  await tx.query(
    `DELETE FROM study_wrong_occurrences WHERE owner_id = $1 AND source_key LIKE 'quiz:%'`,
    [ownerId],
  );
  await tx.query(
    `DELETE FROM study_wrong_items i
      WHERE i.owner_id = $1 AND i.source_type = 'quiz_attempt'
        AND NOT EXISTS (SELECT 1 FROM study_wrong_occurrences o
                         WHERE o.owner_id = i.owner_id AND o.item_id = i.id)`,
    [ownerId],
  );
}

// ── reads ───────────────────────────────────────────────────────────────────

const VISIBLE = `
  i.owner_id = $1 AND i.space_id = $2
  AND (i.stage_id IS NULL OR EXISTS (
    SELECT 1 FROM study_space_courses c
      JOIN stage_meta m ON m.stage_id = c.stage_id AND m.owner_id = c.owner_id AND m.deleted_at IS NULL
     WHERE c.owner_id = i.owner_id AND c.space_id = i.space_id AND c.stage_id = i.stage_id))`;

export interface ItemRow extends WrongItemRow {
  revision: number;
  attemptCount: number;
  firstWrongAt: string;
}

/** One small row per visible item of the space (filtering and facets happen in listWrongItems). */
export async function readItemRows(
  db: Queryable,
  ownerId: string,
  spaceId: string,
): Promise<ItemRow[]> {
  const result = await db.query<{
    id: string;
    source_type: WrongSourceType;
    review_state: WrongReviewState;
    archived_at: string | Date | null;
    concepts: string[];
    revision: number;
    wrong_count: string | number;
    attempt_count: string | number;
    first_wrong: string | Date | null;
    last_wrong: string | Date | null;
  }>(
    `SELECT i.id, i.source_type, i.review_state, i.archived_at, i.concepts, i.revision,
            count(o.source_key) FILTER (WHERE o.outcome <> 'correct') AS wrong_count,
            count(o.source_key) AS attempt_count,
            min(o.occurred_at) FILTER (WHERE o.outcome <> 'correct') AS first_wrong,
            max(o.occurred_at) FILTER (WHERE o.outcome <> 'correct') AS last_wrong
       FROM study_wrong_items i
       JOIN study_wrong_occurrences o ON o.owner_id = i.owner_id AND o.item_id = i.id
      WHERE ${VISIBLE}
      GROUP BY i.owner_id, i.id`,
    [ownerId, spaceId],
  );
  return result.rows
    .filter((row) => Number(row.wrong_count) > 0 && row.first_wrong && row.last_wrong)
    .map((row) => ({
      id: row.id,
      sourceType: row.source_type,
      reviewState: row.review_state,
      archived: row.archived_at !== null,
      concepts: row.concepts ?? [],
      revision: Number(row.revision),
      wrongCount: Number(row.wrong_count),
      attemptCount: Number(row.attempt_count),
      firstWrongAt: iso(row.first_wrong!),
      lastWrongAt: iso(row.last_wrong!),
    }));
}

interface OccurrenceRow extends Record<string, unknown> {
  item_id: string;
  source_key: string;
  occurred_at: string | Date;
  outcome: WrongOutcome;
  earned: string | number;
  points: string | number;
  question: unknown;
  response: unknown;
  grading: unknown;
  origin: unknown;
}

function sourceTypeOf(sourceKey: string): WrongSourceType {
  return sourceKey.startsWith('exam:')
    ? 'exam_attempt'
    : sourceKey.startsWith('quiz:')
      ? 'quiz_attempt'
      : 'learning_check';
}

function occurrenceView(row: OccurrenceRow): WrongOccurrenceView {
  return {
    sourceKey: row.source_key,
    sourceType: sourceTypeOf(row.source_key),
    occurredAt: iso(row.occurred_at),
    outcome: row.outcome,
    earned: Number(row.earned),
    points: Number(row.points),
    question: json<WrongQuestion>(row.question)!,
    response: json<WrongResponse>(row.response),
    grading: json<WrongGrading>(row.grading)!,
    origin: json<WrongOrigin>(row.origin) ?? {},
  };
}

/** The page's items: each with its newest answer and the question as last asked wrongly. */
export async function readItemSummaries(
  db: Queryable,
  ownerId: string,
  spaceId: string,
  rows: readonly ItemRow[],
): Promise<WrongItemSummary[]> {
  if (rows.length === 0) return [];
  const result = await db.query<
    OccurrenceRow & { stem_type: string; stem_subtype: string | null; stem: string }
  >(
    `SELECT i.id AS item_id, latest.source_key, latest.occurred_at, latest.outcome, latest.earned,
            latest.points, NULL AS question, NULL AS response, NULL AS grading, latest.origin,
            wrong.question->>'type' AS stem_type, wrong.question->>'subtype' AS stem_subtype,
            left(wrong.question->>'stem', 600) AS stem
       FROM study_wrong_items i
       JOIN LATERAL (
         SELECT o.source_key, o.occurred_at, o.outcome, o.earned, o.points, o.origin
           FROM study_wrong_occurrences o
          WHERE o.owner_id = i.owner_id AND o.item_id = i.id
          ORDER BY o.occurred_at DESC, o.source_key DESC LIMIT 1
       ) latest ON true
       JOIN LATERAL (
         SELECT o.question FROM study_wrong_occurrences o
          WHERE o.owner_id = i.owner_id AND o.item_id = i.id AND o.outcome <> 'correct'
          ORDER BY o.occurred_at DESC, o.source_key DESC LIMIT 1
       ) wrong ON true
      WHERE i.owner_id = $1 AND i.space_id = $2 AND i.id = ANY($3::text[])`,
    [ownerId, spaceId, rows.map((row) => row.id)],
  );
  const byId = new Map(result.rows.map((row) => [row.item_id, row]));
  return rows.flatMap((row) => {
    const found = byId.get(row.id);
    if (!found) return [];
    return [
      {
        id: row.id,
        spaceId,
        sourceType: row.sourceType,
        reviewState: row.reviewState,
        archived: row.archived,
        revision: row.revision,
        concepts: row.concepts,
        wrongCount: row.wrongCount,
        attemptCount: row.attemptCount,
        firstWrongAt: row.firstWrongAt,
        lastWrongAt: row.lastWrongAt,
        latest: {
          outcome: found.outcome,
          earned: Number(found.earned),
          points: Number(found.points),
          occurredAt: iso(found.occurred_at),
          origin: json<WrongOrigin>(found.origin) ?? {},
        },
        question: {
          type: (found.stem_type as WrongQuestion['type']) ?? 'single',
          ...(found.stem_subtype
            ? { subtype: found.stem_subtype as WrongQuestion['subtype'] }
            : {}),
          stem: found.stem ?? '',
        },
      },
    ];
  });
}

/** One visible item (its space comes from the row) or STUDY_WRONG_ITEM_NOT_FOUND. */
export async function findItemSpace(
  db: Queryable,
  ownerId: string,
  itemId: string,
): Promise<{ spaceId: string; stageId: string | null; questionKey: string }> {
  const result = await db.query<{
    space_id: string;
    stage_id: string | null;
    question_key: string;
  }>(
    'SELECT space_id, stage_id, question_key FROM study_wrong_items WHERE owner_id = $1 AND id = $2',
    [ownerId, itemId],
  );
  const row = result.rows[0];
  if (!row) throw new StudyError('STUDY_WRONG_ITEM_NOT_FOUND');
  return { spaceId: row.space_id, stageId: row.stage_id, questionKey: row.question_key };
}

/** Every occurrence of one item, newest first. */
export async function readOccurrences(
  db: Queryable,
  ownerId: string,
  itemId: string,
): Promise<WrongOccurrenceView[]> {
  const result = await db.query<OccurrenceRow>(
    `SELECT item_id, source_key, occurred_at, outcome, earned, points, question, response,
            grading, origin
       FROM study_wrong_occurrences
      WHERE owner_id = $1 AND item_id = $2
      ORDER BY occurred_at DESC, source_key DESC
      LIMIT $3`,
    [ownerId, itemId, WRONGBOOK_LIMITS.occurrencesPerItem],
  );
  return result.rows.map(occurrenceView);
}

export interface ItemStatePatch {
  reviewState?: WrongReviewState;
  archived?: boolean;
}

/** Mark for review / archive with the revision the client saw; a stale one is 409. */
export async function updateItemState(
  db: Queryable,
  ownerId: string,
  itemId: string,
  baseRevision: number,
  patch: ItemStatePatch,
): Promise<{ revision: number; reviewState: WrongReviewState; archived: boolean }> {
  const result = await db.query<{
    revision: number;
    review_state: WrongReviewState;
    archived_at: string | Date | null;
  }>(
    `UPDATE study_wrong_items
        SET review_state = COALESCE($4, review_state),
            archived_at = CASE WHEN $5::boolean IS NULL THEN archived_at
                               WHEN $5::boolean THEN COALESCE(archived_at, clock_timestamp())
                               ELSE NULL END,
            revision = revision + 1, updated_at = clock_timestamp()
      WHERE owner_id = $1 AND id = $2 AND revision = $3
      RETURNING revision, review_state, archived_at`,
    [ownerId, itemId, baseRevision, patch.reviewState ?? null, patch.archived ?? null],
  );
  const row = result.rows[0];
  if (row) {
    return {
      revision: Number(row.revision),
      reviewState: row.review_state,
      archived: row.archived_at !== null,
    };
  }
  const current = await db.query<{
    revision: number;
    review_state: WrongReviewState;
    archived_at: string | Date | null;
  }>(
    'SELECT revision, review_state, archived_at FROM study_wrong_items WHERE owner_id = $1 AND id = $2',
    [ownerId, itemId],
  );
  if (!current.rows[0]) throw new StudyError('STUDY_WRONG_ITEM_NOT_FOUND');
  throw new StudyError('STUDY_REVISION_CONFLICT', {
    current: {
      revision: Number(current.rows[0].revision),
      reviewState: current.rows[0].review_state,
      archived: current.rows[0].archived_at !== null,
    },
  });
}
