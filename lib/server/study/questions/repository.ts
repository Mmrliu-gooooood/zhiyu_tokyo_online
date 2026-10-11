/**
 * Question bank repository (accounts v28, learning plan B07). Every query
 * names the owner explicitly; on hosted databases web also runs owner-bound
 * under app_web.
 *
 * - A question's content lives in immutable versions; editing appends one.
 * - Importing de-duplicates per space by the fingerprint recorded at creation
 *   and by the current content hash, so the same file (or a question the
 *   student already has) is never added twice — also under concurrent
 *   imports, through the unique fingerprint constraint.
 * - Concepts are created on first use by name and referenced by id.
 */
import { createHash, randomBytes } from 'node:crypto';

import type { Queryable } from '@openmaic/storage/document/pg';

import { StudyError, type StudyDb } from '@/lib/server/study/spaces/repository';
import {
  QUESTION_LIMITS,
  blockingIssues,
  canonicalQuestionText,
  conceptKey,
  isGradable,
  validateQuestionContent,
  type ConceptView,
  type QuestionContent,
  type QuestionListResult,
  type QuestionOrigin,
  type QuestionSource,
  type QuestionType,
  type QuestionView,
  type VerificationState,
} from '@/lib/study/questions/contracts';

function iso(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function json<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

function newId(prefix: string): string {
  return `${prefix}-${randomBytes(9).toString('base64url')}`;
}

export function questionContentHash(content: QuestionContent): string {
  return createHash('sha256').update(canonicalQuestionText(content)).digest('hex');
}

// ── spaces ──────────────────────────────────────────────────────────────────

export interface QuestionSpace {
  id: string;
  name: string;
  active: boolean;
}

/** The owner's space; writes need it active (an archived subject is read-only). */
export async function requireQuestionSpace(
  db: Queryable,
  ownerId: string,
  spaceId: string,
  options: { writable: boolean },
): Promise<QuestionSpace> {
  const result = await db.query<{ id: string; name: string; status: string }>(
    `SELECT id, name, status FROM study_spaces WHERE owner_id = $1 AND id = $2`,
    [ownerId, spaceId],
  );
  const row = result.rows[0];
  if (!row) throw new StudyError('STUDY_SPACE_NOT_FOUND');
  if (options.writable && row.status !== 'active') throw new StudyError('STUDY_SPACE_ARCHIVED');
  return { id: row.id, name: row.name, active: row.status === 'active' };
}

/** A course may scope questions only when it is linked to the space. */
export async function assertSpaceCourse(
  db: Queryable,
  ownerId: string,
  spaceId: string,
  stageId: string,
): Promise<void> {
  const result = await db.query(
    `SELECT 1 FROM study_space_courses l
       JOIN stage_meta m ON m.stage_id = l.stage_id AND m.owner_id = l.owner_id
      WHERE l.owner_id = $1 AND l.space_id = $2 AND l.stage_id = $3 AND m.deleted_at IS NULL`,
    [ownerId, spaceId, stageId],
  );
  if (result.rows.length === 0) throw new StudyError('STUDY_COURSE_NOT_FOUND');
}

// ── concepts ────────────────────────────────────────────────────────────────

export async function listConcepts(
  db: Queryable,
  ownerId: string,
  spaceId: string,
): Promise<ConceptView[]> {
  const result = await db.query<{ id: string; name: string; question_count: string | number }>(
    `SELECT c.id, c.name, count(v.question_id) AS question_count
       FROM study_concepts c
       LEFT JOIN study_questions q ON q.owner_id = c.owner_id AND q.space_id = c.space_id
       LEFT JOIN study_question_versions v
         ON v.owner_id = q.owner_id AND v.question_id = q.id AND v.version = q.current_version
        AND c.id = ANY(v.concept_ids)
      WHERE c.owner_id = $1 AND c.space_id = $2
      GROUP BY c.id, c.name
      ORDER BY c.name`,
    [ownerId, spaceId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    questionCount: Number(row.question_count),
  }));
}

/** Concept ids for names (created when new). Keyed by conceptKey. */
async function ensureConcepts(
  tx: Queryable,
  ownerId: string,
  spaceId: string,
  names: readonly string[],
): Promise<Map<string, string>> {
  const byKey = new Map<string, string>();
  for (const name of names) {
    const key = conceptKey(name);
    if (key && !byKey.has(key)) byKey.set(key, name);
  }
  if (byKey.size === 0) return new Map();
  const keys = [...byKey.keys()];
  await tx.query(
    `INSERT INTO study_concepts (owner_id, id, space_id, name, name_key)
     SELECT $1, k.id, $2, k.name, k.name_key
       FROM unnest($3::text[], $4::text[], $5::text[]) AS k(id, name, name_key)
     ON CONFLICT (owner_id, space_id, name_key) DO NOTHING`,
    [ownerId, spaceId, keys.map(() => newId('c')), keys.map((key) => byKey.get(key)!), keys],
  );
  const rows = await tx.query<{ id: string; name_key: string }>(
    `SELECT id, name_key FROM study_concepts
      WHERE owner_id = $1 AND space_id = $2 AND name_key = ANY($3::text[])`,
    [ownerId, spaceId, keys],
  );
  return new Map(rows.rows.map((row) => [row.name_key, row.id]));
}

/** Concept comparison keys for ids in a space (unknown ids are dropped). */
export async function conceptKeysOf(
  db: Queryable,
  ownerId: string,
  spaceId: string,
  conceptIds: readonly string[],
): Promise<Map<string, string>> {
  if (conceptIds.length === 0) return new Map();
  const rows = await db.query<{ id: string; name_key: string }>(
    `SELECT id, name_key FROM study_concepts
      WHERE owner_id = $1 AND space_id = $2 AND id = ANY($3::text[])`,
    [ownerId, spaceId, [...conceptIds]],
  );
  return new Map(rows.rows.map((row) => [row.id, row.name_key]));
}

// ── reading ─────────────────────────────────────────────────────────────────

const QUESTION_COLUMNS = `
  q.id, q.space_id, q.origin, q.current_version, q.stage_id, q.created_at, q.updated_at,
  v.qtype, v.stem, v.options, v.answer, v.explanation, v.concept_ids, v.difficulty, v.points,
  v.source, v.verification, v.gradable, v.content_hash,
  ARRAY(
    SELECT c.name FROM study_concepts c
     WHERE c.owner_id = q.owner_id AND c.id = ANY(v.concept_ids)
     ORDER BY array_position(v.concept_ids, c.id)
  ) AS concept_names`;

const QUESTION_FROM = `
  FROM study_questions q
  JOIN study_question_versions v
    ON v.owner_id = q.owner_id AND v.question_id = q.id AND v.version = q.current_version`;

interface QuestionRow extends Record<string, unknown> {
  id: string;
  space_id: string;
  origin: QuestionOrigin;
  current_version: number;
  stage_id: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  qtype: QuestionType;
  stem: string;
  options: unknown;
  answer: unknown;
  explanation: string | null;
  concept_ids: string[];
  difficulty: number | null;
  points: number;
  source: unknown;
  verification: VerificationState;
  gradable: boolean;
  content_hash: string;
  concept_names: string[];
}

function toView(row: QuestionRow): QuestionView {
  return {
    id: row.id,
    spaceId: row.space_id,
    version: Number(row.current_version),
    origin: row.origin,
    verification: row.verification,
    gradable: row.gradable,
    type: row.qtype,
    stem: row.stem,
    options: json(row.options) ?? [],
    answer: json(row.answer) ?? [],
    explanation: row.explanation,
    concepts: row.concept_names ?? [],
    conceptIds: row.concept_ids ?? [],
    difficulty: row.difficulty === null ? null : Number(row.difficulty),
    points: Number(row.points),
    source: json<QuestionSource>(row.source),
    stageId: row.stage_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export interface QuestionFilter {
  type?: QuestionType;
  verification?: 'verified' | 'unverified';
  /** `drafts`: questions the program cannot grade yet (e.g. no answer). */
  state?: 'gradable' | 'drafts';
  conceptId?: string;
  stageId?: string;
  query?: string;
  offset?: number;
  limit?: number;
}

export async function listQuestions(
  db: Queryable,
  ownerId: string,
  spaceId: string,
  filter: QuestionFilter = {},
): Promise<QuestionListResult> {
  const where = ['q.owner_id = $1', 'q.space_id = $2'];
  const values: unknown[] = [ownerId, spaceId];
  const add = (sql: string, value: unknown) => {
    values.push(value);
    where.push(sql.replace('?', `$${values.length}`));
  };
  if (filter.type) add('v.qtype = ?', filter.type);
  if (filter.verification === 'verified') where.push(`v.verification <> 'unverified'`);
  if (filter.verification === 'unverified') where.push(`v.verification = 'unverified'`);
  if (filter.state === 'gradable') where.push('v.gradable');
  if (filter.state === 'drafts') where.push('NOT v.gradable');
  if (filter.conceptId) add('? = ANY(v.concept_ids)', filter.conceptId);
  if (filter.stageId) add('q.stage_id = ?', filter.stageId);
  if (filter.query) {
    add(`v.stem ILIKE ? ESCAPE '\\'`, `%${filter.query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  const limit = Math.min(filter.limit ?? QUESTION_LIMITS.listPage, QUESTION_LIMITS.listPage);
  const offset = Math.max(0, filter.offset ?? 0);
  const rows = await db.query<QuestionRow & { total: string | number }>(
    `SELECT ${QUESTION_COLUMNS}, count(*) OVER () AS total
       ${QUESTION_FROM}
      WHERE ${where.join(' AND ')}
      ORDER BY q.updated_at DESC, q.id
      LIMIT ${limit} OFFSET ${offset}`,
    values,
  );
  const counts = await db.query<{
    all_count: string | number;
    gradable: string | number;
    verified: string | number;
  }>(
    `SELECT count(*) AS all_count,
            count(*) FILTER (WHERE v.gradable) AS gradable,
            count(*) FILTER (WHERE v.verification <> 'unverified') AS verified
       ${QUESTION_FROM}
      WHERE q.owner_id = $1 AND q.space_id = $2`,
    [ownerId, spaceId],
  );
  const count = counts.rows[0];
  const all = Number(count?.all_count ?? 0);
  const gradable = Number(count?.gradable ?? 0);
  return {
    questions: rows.rows.map(toView),
    total: Number(rows.rows[0]?.total ?? 0),
    counts: { all, gradable, verified: Number(count?.verified ?? 0), drafts: all - gradable },
  };
}

export async function getQuestion(
  db: Queryable,
  ownerId: string,
  questionId: string,
): Promise<QuestionView> {
  const result = await db.query<QuestionRow>(
    `SELECT ${QUESTION_COLUMNS} ${QUESTION_FROM} WHERE q.owner_id = $1 AND q.id = $2`,
    [ownerId, questionId],
  );
  const row = result.rows[0];
  if (!row) throw new StudyError('STUDY_QUESTION_NOT_FOUND');
  return toView(row);
}

// ── writing ─────────────────────────────────────────────────────────────────

export interface NewQuestion {
  content: QuestionContent;
  verification: VerificationState;
  origin: QuestionOrigin;
  /** Defaults to the content hash; pack copies use the pack fingerprint. */
  fingerprint?: string;
  stageId?: string | null;
}

export type InsertOutcome =
  | { status: 'created'; id: string }
  | { status: 'duplicate'; id: string | null };

function assertValid(content: QuestionContent): void {
  const issues = blockingIssues(validateQuestionContent(content));
  if (issues.length) throw new StudyError('STUDY_QUESTION_INVALID', { issues });
}

async function insertVersion(
  tx: Queryable,
  ownerId: string,
  questionId: string,
  version: number,
  content: QuestionContent,
  verification: VerificationState,
  conceptIds: readonly string[],
  hash: string,
): Promise<void> {
  await tx.query(
    `INSERT INTO study_question_versions
       (owner_id, question_id, version, qtype, stem, options, answer, explanation, concept_ids,
        difficulty, points, source, verification, gradable, content_hash)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9::text[], $10, $11, $12::jsonb,
             $13, $14, $15)`,
    [
      ownerId,
      questionId,
      version,
      content.type,
      content.stem,
      JSON.stringify(content.options),
      JSON.stringify(content.answer),
      content.explanation,
      [...conceptIds],
      content.difficulty,
      content.points,
      content.source ? JSON.stringify(content.source) : null,
      verification,
      isGradable(content),
      hash,
    ],
  );
}

/**
 * Add questions to a space in one transaction. A question is a duplicate when
 * the space already has its fingerprint, or a question whose current content
 * is the same, or the same content appears earlier in this batch.
 */
export async function insertQuestions(
  db: StudyDb,
  ownerId: string,
  spaceId: string,
  items: readonly NewQuestion[],
): Promise<InsertOutcome[]> {
  for (const item of items) assertValid(item.content);
  return db.withTransaction(async (tx) => {
    const hashes = items.map((item) => questionContentHash(item.content));
    const fingerprints = items.map((item, index) => item.fingerprint ?? hashes[index]!);
    const existing = await tx.query<{
      id: string;
      source_fingerprint: string;
      content_hash: string;
    }>(
      `SELECT q.id, q.source_fingerprint, v.content_hash ${QUESTION_FROM}
        WHERE q.owner_id = $1 AND q.space_id = $2
          AND (q.source_fingerprint = ANY($3::text[]) OR v.content_hash = ANY($4::text[]))`,
      [ownerId, spaceId, fingerprints, hashes],
    );
    const known = new Map<string, string>();
    for (const row of existing.rows) {
      known.set(row.source_fingerprint, row.id);
      known.set(row.content_hash, row.id);
    }
    const count = await tx.query<{ n: string | number }>(
      `SELECT count(*) AS n FROM study_questions WHERE owner_id = $1 AND space_id = $2`,
      [ownerId, spaceId],
    );
    const fresh = items.filter(
      (_item, index) => !known.has(fingerprints[index]!) && !known.has(hashes[index]!),
    ).length;
    if (Number(count.rows[0]?.n ?? 0) + fresh > QUESTION_LIMITS.questionsPerSpace) {
      throw new StudyError('STUDY_QUESTION_LIMIT');
    }
    const concepts = await ensureConcepts(
      tx,
      ownerId,
      spaceId,
      items.flatMap((item) => item.content.concepts),
    );
    const outcomes: InsertOutcome[] = [];
    for (const [index, item] of items.entries()) {
      const hash = hashes[index]!;
      const fingerprint = fingerprints[index]!;
      const duplicateOf = known.get(fingerprint) ?? known.get(hash);
      if (duplicateOf !== undefined) {
        outcomes.push({ status: 'duplicate', id: duplicateOf });
        continue;
      }
      const id = newId('q');
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO study_questions (owner_id, id, space_id, origin, source_fingerprint, stage_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (owner_id, space_id, source_fingerprint) DO NOTHING
         RETURNING id`,
        [ownerId, id, spaceId, item.origin, fingerprint, item.stageId ?? null],
      );
      if (inserted.rows.length === 0) {
        outcomes.push({ status: 'duplicate', id: null });
        continue;
      }
      const conceptIds = item.content.concepts.map((name) => concepts.get(conceptKey(name))!);
      await insertVersion(tx, ownerId, id, 1, item.content, item.verification, conceptIds, hash);
      known.set(fingerprint, id);
      known.set(hash, id);
      outcomes.push({ status: 'created', id });
    }
    return outcomes;
  });
}

/**
 * Save an edit as a new version (`baseVersion` guards against a stale
 * editor). Nothing changes when content, verification and course are the same.
 */
export async function updateQuestion(
  db: StudyDb,
  ownerId: string,
  questionId: string,
  input: { content: QuestionContent; verification: VerificationState; stageId: string | null },
  baseVersion: number,
): Promise<QuestionView> {
  assertValid(input.content);
  await db.withTransaction(async (tx) => {
    const current = await tx.query<{
      space_id: string;
      current_version: number;
      stage_id: string | null;
      content_hash: string;
      verification: VerificationState;
      explanation: string | null;
      concept_ids: string[];
      difficulty: number | null;
      points: number;
      source: unknown;
    }>(
      `SELECT q.space_id, q.current_version, q.stage_id, v.content_hash, v.verification,
              v.explanation, v.concept_ids, v.difficulty, v.points, v.source
         ${QUESTION_FROM}
        WHERE q.owner_id = $1 AND q.id = $2
        FOR UPDATE OF q`,
      [ownerId, questionId],
    );
    const row = current.rows[0];
    if (!row) throw new StudyError('STUDY_QUESTION_NOT_FOUND');
    if (Number(row.current_version) !== baseVersion) {
      throw new StudyError('STUDY_REVISION_CONFLICT', {
        question: await getQuestion(tx, ownerId, questionId),
      });
    }
    if (input.stageId) await assertSpaceCourse(tx, ownerId, row.space_id, input.stageId);
    const concepts = await ensureConcepts(tx, ownerId, row.space_id, input.content.concepts);
    const conceptIds = input.content.concepts.map((name) => concepts.get(conceptKey(name))!);
    const hash = questionContentHash(input.content);
    const unchanged =
      hash === row.content_hash &&
      input.verification === row.verification &&
      input.stageId === row.stage_id &&
      input.content.explanation === row.explanation &&
      JSON.stringify(conceptIds) === JSON.stringify(row.concept_ids ?? []) &&
      input.content.difficulty === (row.difficulty === null ? null : Number(row.difficulty)) &&
      input.content.points === Number(row.points) &&
      JSON.stringify(input.content.source) === JSON.stringify(json(row.source));
    if (unchanged) return;
    const version = Number(row.current_version) + 1;
    await insertVersion(
      tx,
      ownerId,
      questionId,
      version,
      input.content,
      input.verification,
      conceptIds,
      hash,
    );
    await tx.query(
      `UPDATE study_questions
          SET current_version = $3, stage_id = $4, updated_at = clock_timestamp()
        WHERE owner_id = $1 AND id = $2`,
      [ownerId, questionId, version, input.stageId],
    );
  });
  return getQuestion(db, ownerId, questionId);
}

/** Remove a question and its versions. Papers that froze it are unaffected. */
export async function deleteQuestion(
  db: Queryable,
  ownerId: string,
  questionId: string,
): Promise<void> {
  const result = await db.query(
    `DELETE FROM study_questions WHERE owner_id = $1 AND id = $2 RETURNING id`,
    [ownerId, questionId],
  );
  if (result.rows.length === 0) throw new StudyError('STUDY_QUESTION_NOT_FOUND');
}

// ── paper building ──────────────────────────────────────────────────────────

export interface BankCandidateRow {
  id: string;
  fingerprint: string;
  version: number;
  type: QuestionType;
  conceptKeys: string[];
  stageId: string | null;
  difficulty: number | null;
  verification: VerificationState;
  contentHash: string;
}

/** Gradable current versions of a space's questions, for the paper builder. */
export async function loadBankCandidates(
  db: Queryable,
  ownerId: string,
  spaceId: string,
): Promise<BankCandidateRow[]> {
  const result = await db.query<{
    id: string;
    source_fingerprint: string;
    current_version: number;
    qtype: QuestionType;
    stage_id: string | null;
    difficulty: number | null;
    verification: VerificationState;
    content_hash: string;
    concept_keys: string[];
  }>(
    `SELECT q.id, q.source_fingerprint, q.current_version, v.qtype, q.stage_id, v.difficulty, v.verification,
            v.content_hash,
            ARRAY(SELECT c.name_key FROM study_concepts c
                   WHERE c.owner_id = q.owner_id AND c.id = ANY(v.concept_ids)) AS concept_keys
       ${QUESTION_FROM}
      WHERE q.owner_id = $1 AND q.space_id = $2 AND v.gradable
      ORDER BY q.id
      LIMIT ${QUESTION_LIMITS.questionsPerSpace}`,
    [ownerId, spaceId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    fingerprint: row.source_fingerprint,
    version: Number(row.current_version),
    type: row.qtype,
    conceptKeys: row.concept_keys ?? [],
    stageId: row.stage_id,
    difficulty: row.difficulty === null ? null : Number(row.difficulty),
    verification: row.verification,
    contentHash: row.content_hash,
  }));
}

export interface FrozenQuestion {
  id: string;
  version: number;
  origin: QuestionOrigin;
  verification: VerificationState;
  content: QuestionContent;
  contentHash: string;
}

/** The exact versions a paper freezes (read inside the publishing transaction). */
export async function loadQuestionVersions(
  db: Queryable,
  ownerId: string,
  refs: ReadonlyArray<{ id: string; version: number }>,
): Promise<Map<string, FrozenQuestion>> {
  if (refs.length === 0) return new Map();
  const result = await db.query<QuestionRow & { version: number }>(
    `SELECT q.id, q.space_id, q.origin, v.version AS current_version, q.stage_id, q.created_at,
            q.updated_at, v.qtype, v.stem, v.options, v.answer, v.explanation, v.concept_ids,
            v.difficulty, v.points, v.source, v.verification, v.gradable, v.content_hash,
            ARRAY(
              SELECT c.name FROM study_concepts c
               WHERE c.owner_id = q.owner_id AND c.id = ANY(v.concept_ids)
               ORDER BY array_position(v.concept_ids, c.id)
            ) AS concept_names
       FROM unnest($2::text[], $3::int[]) AS r(id, version)
       JOIN study_questions q ON q.owner_id = $1 AND q.id = r.id
       JOIN study_question_versions v
         ON v.owner_id = q.owner_id AND v.question_id = q.id AND v.version = r.version`,
    [ownerId, refs.map((ref) => ref.id), refs.map((ref) => ref.version)],
  );
  return new Map(
    result.rows.map((row) => {
      const view = toView(row);
      return [
        `${view.id}@${view.version}`,
        {
          id: view.id,
          version: view.version,
          origin: view.origin,
          verification: view.verification,
          content: {
            type: view.type,
            stem: view.stem,
            options: view.options,
            answer: view.answer,
            explanation: view.explanation,
            concepts: view.concepts,
            difficulty: view.difficulty,
            points: view.points,
            source: view.source,
          },
          contentHash: row.content_hash,
        },
      ];
    }),
  );
}
