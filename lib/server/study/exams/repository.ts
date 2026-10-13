/**
 * Papers and attempts repository (accounts v28, learning plan B07). Every
 * query names the owner explicitly; on hosted databases web also runs
 * owner-bound under app_web.
 *
 * - Papers and their items are written once, in one transaction, and never
 *   updated; the publishing request's idempotency key makes a retry return
 *   the same paper.
 * - Views are built field by field (`toItemView`); an open attempt never
 *   reads the answer key at all.
 * - Draft saves compare the attempt's revision; submitting is a single
 *   conditional update of an open attempt, so concurrent submits produce one
 *   result and the others read it back.
 * - Open items (B09): the paper freezes their grading guide next to the key;
 *   submitting also creates one pending grading row per answered open item
 *   (accounts v30), and reports and summaries add the gradings made so far.
 */
import { randomBytes } from 'node:crypto';

import type { Queryable } from '@openmaic/storage/document/pg';

import {
  insertSubmissionGradings,
  listAttemptGradings,
  openItemTotals,
} from '@/lib/server/study/grading/repository';
import { StudyError, type StudyDb } from '@/lib/server/study/spaces/repository';
import {
  ATTEMPT_LIMITS,
  isOpenAnswer,
  summarizeReport,
  toItemView,
  type AttemptAnswers,
  type AttemptGrading,
  type AttemptSummary,
  type AttemptView,
  type PaperItemKey,
  type PaperItemView,
  type PaperSummary,
  type ReportItem,
} from '@/lib/study/assessments/contracts';
import type { ExamBlueprint } from '@/lib/study/questions/blueprint';
import type { GradingGuide } from '@/lib/study/questions/contracts';

function iso(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function json<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

export function createPaperId(): string {
  return `paper-${randomBytes(9).toString('base64url')}`;
}

// ── papers ──────────────────────────────────────────────────────────────────

export interface FrozenItem {
  questionId: string | null;
  questionVersion: number | null;
  packQuestion: string | null;
  contentHash: string;
  /** Everything the student may see before submitting (no key). */
  snapshot: Record<string, unknown>;
  key: PaperItemKey;
}

export interface NewPaper {
  id: string;
  spaceId: string;
  title: string;
  blueprint: ExamBlueprint;
  items: FrozenItem[];
  idempotencyKey: string;
  requestHash: string;
}

export async function findPaperByKey(
  db: Queryable,
  ownerId: string,
  idempotencyKey: string,
): Promise<{ id: string; requestHash: string } | null> {
  const result = await db.query<{ id: string; request_hash: string }>(
    `SELECT id, request_hash FROM study_exam_papers WHERE owner_id = $1 AND idempotency_key = $2`,
    [ownerId, idempotencyKey],
  );
  const row = result.rows[0];
  return row ? { id: row.id, requestHash: row.request_hash } : null;
}

/** Insert a paper with its frozen items. Returns false when the key was taken meanwhile. */
export async function insertPaper(
  tx: Queryable,
  ownerId: string,
  paper: NewPaper,
): Promise<boolean> {
  const totalPoints = paper.items.reduce((sum, item) => sum + Number(item.snapshot.points ?? 1), 0);
  const inserted = await tx.query(
    `INSERT INTO study_exam_papers
       (owner_id, id, space_id, title, mode, blueprint, item_count, total_points,
        idempotency_key, request_hash)
     VALUES ($1, $2, $3, $4, 'bank', $5::jsonb, $6, $7, $8, $9)
     ON CONFLICT (owner_id, idempotency_key) DO NOTHING
     RETURNING id`,
    [
      ownerId,
      paper.id,
      paper.spaceId,
      paper.title,
      JSON.stringify(paper.blueprint),
      paper.items.length,
      totalPoints,
      paper.idempotencyKey,
      paper.requestHash,
    ],
  );
  if (inserted.rows.length === 0) return false;
  await tx.query(
    `INSERT INTO study_exam_items
       (owner_id, paper_id, position, question_id, question_version, pack_question, content_hash,
        snapshot, answer_key, explanation, guide)
     SELECT $1, $2, i.position, i.question_id, i.question_version, i.pack_question, i.content_hash,
            i.snapshot, i.answer_key, i.explanation, i.guide
       FROM jsonb_to_recordset($3::jsonb) AS i(
         position int, question_id text, question_version int, pack_question text,
         content_hash text, snapshot jsonb, answer_key jsonb, explanation text, guide jsonb)`,
    [
      ownerId,
      paper.id,
      JSON.stringify(
        paper.items.map((item, index) => ({
          position: index + 1,
          question_id: item.questionId,
          question_version: item.questionVersion,
          pack_question: item.packQuestion,
          content_hash: item.contentHash,
          snapshot: item.snapshot,
          answer_key: item.key.answer,
          explanation: item.key.explanation,
          guide: item.key.guide,
        })),
      ),
    ],
  );
  return true;
}

interface PaperRow extends Record<string, unknown> {
  id: string;
  space_id: string;
  title: string;
  item_count: number;
  total_points: number;
  created_at: string | Date;
}

function attemptSummary(
  row: Record<string, unknown>,
  open: { earned: number; ungraded: number } | undefined,
): AttemptSummary {
  return {
    id: String(row.id),
    status: row.status === 'submitted' ? 'submitted' : 'in_progress',
    startedAt: iso(row.started_at as string),
    submittedAt: row.submitted_at ? iso(row.submitted_at as string) : null,
    earned:
      row.earned === null || row.earned === undefined
        ? null
        : Number(row.earned) + (open?.earned ?? 0),
    totalPoints:
      row.total_points === null || row.total_points === undefined ? null : Number(row.total_points),
    ungraded: open?.ungraded ?? 0,
  };
}

async function attemptsOf(
  db: Queryable,
  ownerId: string,
  paperIds: readonly string[],
): Promise<Map<string, AttemptSummary[]>> {
  const map = new Map<string, AttemptSummary[]>();
  if (paperIds.length === 0) return map;
  const result = await db.query(
    `SELECT id, paper_id, status, started_at, submitted_at, earned, total_points, grading
       FROM study_exam_attempts
      WHERE owner_id = $1 AND paper_id = ANY($2::text[])
      ORDER BY started_at DESC`,
    [ownerId, [...paperIds]],
  );
  const totals = await openItemTotals(
    db,
    ownerId,
    result.rows
      .filter((row) => row.status === 'submitted')
      .map((row) => ({
        attemptId: String(row.id),
        grading: json<AttemptGrading>(row.grading),
      })),
  );
  for (const row of result.rows) {
    const paperId = String(row.paper_id);
    map.set(paperId, [
      ...(map.get(paperId) ?? []),
      attemptSummary(row, totals.get(String(row.id))),
    ]);
  }
  return map;
}

export async function listPapers(
  db: Queryable,
  ownerId: string,
  spaceId: string,
): Promise<PaperSummary[]> {
  const result = await db.query<PaperRow>(
    `SELECT id, space_id, title, item_count, total_points, created_at
       FROM study_exam_papers
      WHERE owner_id = $1 AND space_id = $2
      ORDER BY created_at DESC
      LIMIT ${ATTEMPT_LIMITS.papersListed}`,
    [ownerId, spaceId],
  );
  const attempts = await attemptsOf(
    db,
    ownerId,
    result.rows.map((row) => row.id),
  );
  return result.rows.map((row) => ({
    id: row.id,
    spaceId: row.space_id,
    title: row.title,
    itemCount: Number(row.item_count),
    totalPoints: Number(row.total_points),
    createdAt: iso(row.created_at),
    attempts: attempts.get(row.id) ?? [],
  }));
}

export async function getPaperSummary(
  db: Queryable,
  ownerId: string,
  paperId: string,
): Promise<PaperSummary> {
  const result = await db.query<PaperRow>(
    `SELECT id, space_id, title, item_count, total_points, created_at
       FROM study_exam_papers WHERE owner_id = $1 AND id = $2`,
    [ownerId, paperId],
  );
  const row = result.rows[0];
  if (!row) throw new StudyError('STUDY_PAPER_NOT_FOUND');
  const attempts = await attemptsOf(db, ownerId, [row.id]);
  return {
    id: row.id,
    spaceId: row.space_id,
    title: row.title,
    itemCount: Number(row.item_count),
    totalPoints: Number(row.total_points),
    createdAt: iso(row.created_at),
    attempts: attempts.get(row.id) ?? [],
  };
}

export async function deletePaper(db: Queryable, ownerId: string, paperId: string): Promise<void> {
  const result = await db.query(
    `DELETE FROM study_exam_papers WHERE owner_id = $1 AND id = $2 RETURNING id`,
    [ownerId, paperId],
  );
  if (result.rows.length === 0) throw new StudyError('STUDY_PAPER_NOT_FOUND');
}

/** The items as the student sees them before submitting: no key column is read. */
export async function paperItemViews(
  db: Queryable,
  ownerId: string,
  paperId: string,
): Promise<PaperItemView[]> {
  const result = await db.query<{ position: number; snapshot: unknown }>(
    `SELECT position, snapshot FROM study_exam_items
      WHERE owner_id = $1 AND paper_id = $2 ORDER BY position`,
    [ownerId, paperId],
  );
  return result.rows.map((row) =>
    toItemView(Number(row.position), json<Record<string, unknown>>(row.snapshot) ?? {}),
  );
}

/** One item with its key (grading of a single open item). */
export async function paperItemWithKey(
  db: Queryable,
  ownerId: string,
  paperId: string,
  position: number,
): Promise<(PaperItemView & PaperItemKey) | null> {
  const items = await paperItemsWithKeys(db, ownerId, paperId, position);
  return items[0] ?? null;
}

/** Items with their keys, for grading and the submitted report only. */
export async function paperItemsWithKeys(
  db: Queryable,
  ownerId: string,
  paperId: string,
  position?: number,
): Promise<Array<PaperItemView & PaperItemKey>> {
  const result = await db.query<{
    position: number;
    snapshot: unknown;
    answer_key: unknown;
    explanation: string | null;
    guide: unknown;
  }>(
    `SELECT position, snapshot, answer_key, explanation, guide FROM study_exam_items
      WHERE owner_id = $1 AND paper_id = $2 AND ($3::int IS NULL OR position = $3)
      ORDER BY position`,
    [ownerId, paperId, position ?? null],
  );
  return result.rows.map((row) => {
    const view = toItemView(
      Number(row.position),
      json<Record<string, unknown>>(row.snapshot) ?? {},
    );
    return {
      ...view,
      answer: json<string[]>(row.answer_key) ?? [],
      explanation: row.explanation,
      guide: view.type === 'short_answer' ? json<GradingGuide>(row.guide) : null,
    };
  });
}

/** What this subject's submitted papers already asked (for "avoid questions I've done"). */
export async function seenInSpace(
  db: Queryable,
  ownerId: string,
  spaceId: string,
): Promise<{ questionIds: Set<string>; packQuestions: Set<string>; hashes: Set<string> }> {
  const result = await db.query<{
    question_id: string | null;
    pack_question: string | null;
    content_hash: string;
  }>(
    `SELECT DISTINCT i.question_id, i.pack_question, i.content_hash
       FROM study_exam_items i
       JOIN study_exam_papers p ON p.owner_id = i.owner_id AND p.id = i.paper_id
      WHERE i.owner_id = $1 AND p.space_id = $2
        AND EXISTS (
          SELECT 1 FROM study_exam_attempts a
           WHERE a.owner_id = p.owner_id AND a.paper_id = p.id AND a.status = 'submitted'
        )`,
    [ownerId, spaceId],
  );
  const seen = {
    questionIds: new Set<string>(),
    packQuestions: new Set<string>(),
    hashes: new Set<string>(),
  };
  for (const row of result.rows) {
    if (row.question_id) seen.questionIds.add(row.question_id);
    if (row.pack_question) seen.packQuestions.add(row.pack_question);
    seen.hashes.add(row.content_hash);
  }
  return seen;
}

// ── attempts ────────────────────────────────────────────────────────────────

export async function attemptPaperId(
  db: Queryable,
  ownerId: string,
  attemptId: string,
): Promise<string> {
  const result = await db.query<{ paper_id: string }>(
    `SELECT paper_id FROM study_exam_attempts WHERE owner_id = $1 AND id = $2`,
    [ownerId, attemptId],
  );
  const paperId = result.rows[0]?.paper_id;
  if (!paperId) throw new StudyError('STUDY_ATTEMPT_NOT_FOUND');
  return paperId;
}

/** The open attempt of a paper, or a new one (one open attempt per paper). */
export async function openAttempt(
  db: StudyDb,
  ownerId: string,
  paperId: string,
): Promise<{ id: string; created: boolean }> {
  return db.withTransaction(async (tx) => {
    const paper = await tx.query(
      `SELECT 1 FROM study_exam_papers WHERE owner_id = $1 AND id = $2`,
      [ownerId, paperId],
    );
    if (paper.rows.length === 0) throw new StudyError('STUDY_PAPER_NOT_FOUND');
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO study_exam_attempts (owner_id, id, paper_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (owner_id, paper_id) WHERE status = 'in_progress' DO NOTHING
       RETURNING id`,
      [ownerId, `att-${randomBytes(9).toString('base64url')}`, paperId],
    );
    if (inserted.rows[0]) return { id: inserted.rows[0].id, created: true };
    const open = await tx.query<{ id: string }>(
      `SELECT id FROM study_exam_attempts
        WHERE owner_id = $1 AND paper_id = $2 AND status = 'in_progress'`,
      [ownerId, paperId],
    );
    return { id: open.rows[0]!.id, created: false };
  });
}

interface AttemptRow extends Record<string, unknown> {
  id: string;
  paper_id: string;
  status: 'in_progress' | 'submitted';
  answers: unknown;
  revision: number;
  started_at: string | Date;
  updated_at: string | Date;
  submitted_at: string | Date | null;
  submit_key: string | null;
  grading: unknown;
  space_id: string;
  title: string;
}

async function attemptRow(db: Queryable, ownerId: string, attemptId: string): Promise<AttemptRow> {
  const result = await db.query<AttemptRow>(
    `SELECT a.id, a.paper_id, a.status, a.answers, a.revision, a.started_at, a.updated_at,
            a.submitted_at, a.submit_key, a.grading, p.space_id, p.title
       FROM study_exam_attempts a
       JOIN study_exam_papers p ON p.owner_id = a.owner_id AND p.id = a.paper_id
      WHERE a.owner_id = $1 AND a.id = $2`,
    [ownerId, attemptId],
  );
  const row = result.rows[0];
  if (!row) throw new StudyError('STUDY_ATTEMPT_NOT_FOUND');
  return row;
}

/**
 * Lock the attempt while it is open; null once it is submitted. A locking
 * read under row security also applies the update policy, which only matches
 * open attempts, so a submitted attempt is never returned here — callers read
 * it unlocked first (attemptRow) to tell "submitted" from "missing".
 */
async function lockOpenAttempt(
  tx: Queryable,
  ownerId: string,
  attemptId: string,
): Promise<{ answers: AttemptAnswers; revision: number } | null> {
  const result = await tx.query<{ answers: unknown; revision: number }>(
    `SELECT answers, revision FROM study_exam_attempts
      WHERE owner_id = $1 AND id = $2 AND status = 'in_progress'
      FOR UPDATE`,
    [ownerId, attemptId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { answers: json<AttemptAnswers>(row.answers) ?? {}, revision: Number(row.revision) };
}

/** An attempt as the student sees it: items without keys while open, the report once submitted. */
export async function getAttemptView(
  db: Queryable,
  ownerId: string,
  attemptId: string,
): Promise<AttemptView> {
  const row = await attemptRow(db, ownerId, attemptId);
  const answers = json<AttemptAnswers>(row.answers) ?? {};
  const base = {
    id: row.id,
    paperId: row.paper_id,
    spaceId: row.space_id,
    title: row.title,
    status: row.status,
    revision: Number(row.revision),
    answers,
    startedAt: iso(row.started_at),
    updatedAt: iso(row.updated_at),
    submittedAt: row.submitted_at ? iso(row.submitted_at) : null,
  };
  if (row.status !== 'submitted') {
    return { ...base, items: await paperItemViews(db, ownerId, row.paper_id), report: null };
  }
  const grading = json<AttemptGrading>(row.grading)!;
  const gradings = await listAttemptGradings(db, ownerId, attemptId);
  const { summary, items: current } = summarizeReport(grading, gradings);
  const results = new Map(current.map((item) => [item.position, item]));
  const items = await paperItemsWithKeys(db, ownerId, row.paper_id);
  const report: ReportItem[] = items.map((item) => {
    const answer = answers[String(item.position)];
    return {
      ...item,
      response: Array.isArray(answer) ? answer : [],
      openResponse: isOpenAnswer(answer) ? answer : null,
      outcome: results.get(item.position)?.outcome ?? 'ungradable',
      earned: results.get(item.position)?.earned ?? 0,
      gradings: gradings.get(item.position) ?? [],
    };
  });
  return {
    ...base,
    items: items.map(
      ({ answer: _answer, explanation: _explanation, guide: _guide, ...view }) => view,
    ),
    report: { grading, summary, items: report },
  };
}

/** Save a draft; a stale revision gets 409 with the stored answers. */
export async function saveDraftAnswers(
  db: StudyDb,
  ownerId: string,
  attemptId: string,
  answers: AttemptAnswers,
  baseRevision: number,
): Promise<{ revision: number; updatedAt: string }> {
  return db.withTransaction(async (tx) => {
    await attemptRow(tx, ownerId, attemptId);
    const open = await lockOpenAttempt(tx, ownerId, attemptId);
    if (!open) throw new StudyError('STUDY_ATTEMPT_SUBMITTED');
    if (open.revision !== baseRevision) {
      throw new StudyError('STUDY_REVISION_CONFLICT', {
        answers: open.answers,
        revision: open.revision,
      });
    }
    const updated = await tx.query<{ revision: number; updated_at: string | Date }>(
      `UPDATE study_exam_attempts
          SET answers = $3::jsonb, revision = revision + 1, updated_at = clock_timestamp()
        WHERE owner_id = $1 AND id = $2 AND status = 'in_progress'
        RETURNING revision, updated_at`,
      [ownerId, attemptId, JSON.stringify(answers)],
    );
    const saved = updated.rows[0];
    if (!saved) throw new StudyError('STUDY_ATTEMPT_SUBMITTED');
    return { revision: Number(saved.revision), updatedAt: iso(saved.updated_at) };
  });
}

export interface SubmitInput {
  /** Final answers; null submits the stored draft. */
  answers: AttemptAnswers | null;
  /** Required with `answers`: the draft revision the client last saw. */
  baseRevision: number | null;
  submitKey: string;
}

export type SubmitOutcome = { kind: 'submitted' } | { kind: 'already'; sameKey: boolean };

/**
 * Freeze the answers and grading of an open attempt. `grade` runs inside the
 * transaction on the paper's items and the final answers. When the attempt
 * was already submitted (a retry, another tab, another device) nothing
 * changes and the caller reads the stored result.
 */
export async function submitAttempt(
  db: StudyDb,
  ownerId: string,
  attemptId: string,
  input: SubmitInput,
  grade: (
    items: Array<PaperItemView & PaperItemKey>,
    answers: AttemptAnswers,
  ) => { answers: AttemptAnswers; grading: AttemptGrading; digest: string } | null,
): Promise<SubmitOutcome> {
  return db.withTransaction(async (tx) => {
    const row = await attemptRow(tx, ownerId, attemptId);
    const open =
      row.status === 'in_progress' ? await lockOpenAttempt(tx, ownerId, attemptId) : null;
    if (!open) {
      // Submitted before, or by a concurrent request that held the lock first.
      const stored = row.status === 'submitted' ? row : await attemptRow(tx, ownerId, attemptId);
      return { kind: 'already', sameKey: stored.submit_key === input.submitKey };
    }
    if (input.answers && input.baseRevision !== open.revision) {
      throw new StudyError('STUDY_REVISION_CONFLICT', {
        answers: open.answers,
        revision: open.revision,
      });
    }
    const items = await paperItemsWithKeys(tx, ownerId, row.paper_id);
    const graded = grade(items, input.answers ?? open.answers);
    if (!graded) throw new StudyError('STUDY_ANSWERS_INVALID');
    const updated = await tx.query(
      `UPDATE study_exam_attempts
          SET status = 'submitted', answers = $3::jsonb, grading = $4::jsonb, earned = $5,
              total_points = $6, submitted_digest = $7, submit_key = $8,
              submitted_at = clock_timestamp(), updated_at = clock_timestamp(),
              revision = revision + 1
        WHERE owner_id = $1 AND id = $2 AND status = 'in_progress'
        RETURNING id`,
      [
        ownerId,
        attemptId,
        JSON.stringify(graded.answers),
        JSON.stringify(graded.grading),
        graded.grading.earned,
        graded.grading.totalPoints,
        graded.digest,
        input.submitKey,
      ],
    );
    if (updated.rows.length === 0) return { kind: 'already', sameKey: false };
    await insertSubmissionGradings(tx, ownerId, attemptId, graded.grading);
    return { kind: 'submitted' };
  });
}

// ── learning-event source (B06 projector) ───────────────────────────────────

export interface SubmittedAttemptRow {
  attemptId: string;
  paperId: string;
  spaceId: string;
  submittedAt: string;
  itemCount: number;
  grading: AttemptGrading;
  /** Open items (B09): their points so far, how many fully right, and how many have no score yet. */
  open: { earned: number; correct: number; ungraded: number };
}

export async function submittedAttempts(
  db: Queryable,
  ownerId: string,
  attemptId?: string,
): Promise<SubmittedAttemptRow[]> {
  const result = await db.query<{
    id: string;
    paper_id: string;
    space_id: string;
    submitted_at: string | Date;
    item_count: number;
    grading: unknown;
  }>(
    `SELECT a.id, a.paper_id, p.space_id, a.submitted_at, p.item_count, a.grading
       FROM study_exam_attempts a
       JOIN study_exam_papers p ON p.owner_id = a.owner_id AND p.id = a.paper_id
      WHERE a.owner_id = $1 AND a.status = 'submitted'
        AND ($2::text IS NULL OR a.id = $2)
      ORDER BY a.submitted_at DESC LIMIT 500`,
    [ownerId, attemptId ?? null],
  );
  const rows = result.rows.map((row) => ({
    attemptId: row.id,
    paperId: row.paper_id,
    spaceId: row.space_id,
    submittedAt: iso(row.submitted_at),
    itemCount: Number(row.item_count),
    grading: json<AttemptGrading>(row.grading)!,
  }));
  const totals = await openItemTotals(db, ownerId, rows);
  return rows.map((row) => ({
    ...row,
    open: totals.get(row.attemptId) ?? { earned: 0, correct: 0, ungraded: 0 },
  }));
}
