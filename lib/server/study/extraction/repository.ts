/**
 * Exercise extraction repository (accounts v29, learning plan B08). Every
 * query names the owner explicitly; on hosted databases web also runs
 * owner-bound under app_web.
 */
import { randomBytes } from 'node:crypto';

import type { Queryable } from '@openmaic/storage/document/pg';

import { StudyError } from '@/lib/server/study/spaces/repository';
import { isCommittable } from '@/lib/study/extraction/candidate';
import {
  EMPTY_EXTRACTION_USAGE,
  type AnswerBasis,
  type AnswerRef,
  type CandidateContent,
  type CandidateStatus,
  type CandidateSuggestion,
  type CandidateView,
  type ExtractionCounts,
  type ExtractionStats,
  type ExtractionUsage,
  type ExtractionView,
  type SourceLine,
} from '@/lib/study/extraction/contracts';

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

export const createExtractionId = () => newId('qx');
export const createCandidateId = () => newId('qc');

/** What the extractor produced, kept so the student can restore it. */
export interface CandidateOriginal {
  content: CandidateContent;
  answerBasis: AnswerBasis;
  answerRef: AnswerRef | null;
}

export interface NewCandidate {
  id: string;
  label: string | null;
  section: string | null;
  content: CandidateContent;
  lines: SourceLine[];
  pages: number[];
  answerBasis: AnswerBasis;
  answerRef: AnswerRef | null;
  original: CandidateOriginal;
}

export interface NewExtraction {
  id: string;
  spaceId: string;
  materialId: string;
  versionId: string;
  artifactId: string;
  pageFrom: number | null;
  pageTo: number | null;
  strategy: string;
  requestKey: string;
  stats: ExtractionStats;
}

// ── extractions ─────────────────────────────────────────────────────────────

export async function findExtractionByKey(
  db: Queryable,
  ownerId: string,
  spaceId: string,
  requestKey: string,
): Promise<string | null> {
  const result = await db.query<{ id: string }>(
    `SELECT id FROM study_question_extractions
      WHERE owner_id = $1 AND space_id = $2 AND request_key = $3`,
    [ownerId, spaceId, requestKey],
  );
  return result.rows[0]?.id ?? null;
}

export async function countExtractions(
  db: Queryable,
  ownerId: string,
  spaceId: string,
): Promise<number> {
  const result = await db.query<{ n: string | number }>(
    `SELECT count(*) AS n FROM study_question_extractions WHERE owner_id = $1 AND space_id = $2`,
    [ownerId, spaceId],
  );
  return Number(result.rows[0]?.n ?? 0);
}

/**
 * Write an extraction with its candidates. A concurrent identical request
 * loses the unique request key and gets the existing extraction instead.
 */
export async function insertExtraction(
  tx: Queryable,
  ownerId: string,
  extraction: NewExtraction,
  candidates: readonly NewCandidate[],
): Promise<{ id: string; created: boolean }> {
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO study_question_extractions
       (owner_id, id, space_id, material_id, version_id, artifact_id, page_from, page_to,
        strategy, request_key, stats)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
     ON CONFLICT (owner_id, space_id, request_key) DO NOTHING
     RETURNING id`,
    [
      ownerId,
      extraction.id,
      extraction.spaceId,
      extraction.materialId,
      extraction.versionId,
      extraction.artifactId,
      extraction.pageFrom,
      extraction.pageTo,
      extraction.strategy,
      extraction.requestKey,
      JSON.stringify(extraction.stats),
    ],
  );
  if (!inserted.rows[0]) {
    const existing = await findExtractionByKey(
      tx,
      ownerId,
      extraction.spaceId,
      extraction.requestKey,
    );
    return { id: existing!, created: false };
  }
  await insertCandidates(tx, ownerId, extraction.id, candidates, 1);
  return { id: extraction.id, created: true };
}

async function insertCandidates(
  tx: Queryable,
  ownerId: string,
  extractionId: string,
  candidates: readonly NewCandidate[],
  firstPosition: number,
): Promise<void> {
  for (let start = 0; start < candidates.length; start += 100) {
    const batch = candidates.slice(start, start + 100);
    const values: string[] = [];
    const params: unknown[] = [];
    batch.forEach((candidate, index) => {
      const base = params.length;
      values.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6},
          $${base + 7}::jsonb, $${base + 8}::jsonb, $${base + 9}::jsonb, $${base + 10}::int[],
          $${base + 11}, $${base + 12}::jsonb)`,
      );
      params.push(
        ownerId,
        extractionId,
        candidate.id,
        firstPosition + start + index,
        candidate.label,
        candidate.section,
        JSON.stringify(candidate.content),
        JSON.stringify(candidate.original),
        JSON.stringify(candidate.lines),
        candidate.pages,
        candidate.answerBasis,
        candidate.answerRef ? JSON.stringify(candidate.answerRef) : null,
      );
    });
    await tx.query(
      `INSERT INTO study_question_candidates
         (owner_id, extraction_id, id, position, label, section, content, original, source_lines,
          pages, answer_basis, answer_ref)
       VALUES ${values.join(', ')}`,
      params,
    );
  }
}

interface ExtractionRow extends Record<string, unknown> {
  id: string;
  space_id: string;
  material_id: string;
  version_id: string;
  artifact_id: string;
  page_from: number | null;
  page_to: number | null;
  strategy: string;
  stats: unknown;
  usage: unknown;
  created_at: string | Date;
  updated_at: string | Date;
  title: string | null;
  material_status: string | null;
  current_version_id: string | null;
  version_no: number | null;
  linked: boolean;
  total: string | number;
  drafts: string | number;
  committed: string | number;
  discarded: string | number;
  open_drafts: string | number;
}

const EXTRACTION_SELECT = `
  SELECT e.id, e.space_id, e.material_id, e.version_id, e.artifact_id, e.page_from, e.page_to,
         e.strategy, e.stats, e.usage, e.created_at, e.updated_at,
         m.title, m.status AS material_status, m.current_version_id, v.version_no,
         EXISTS (
           SELECT 1 FROM study_space_materials l
            WHERE l.owner_id = e.owner_id AND l.space_id = e.space_id
              AND l.material_id = e.material_id
         ) AS linked,
         (SELECT count(*) FROM study_question_candidates c
           WHERE c.owner_id = e.owner_id AND c.extraction_id = e.id) AS total,
         (SELECT count(*) FROM study_question_candidates c
           WHERE c.owner_id = e.owner_id AND c.extraction_id = e.id AND c.status = 'draft') AS drafts,
         (SELECT count(*) FROM study_question_candidates c
           WHERE c.owner_id = e.owner_id AND c.extraction_id = e.id AND c.status = 'committed') AS committed,
         (SELECT count(*) FROM study_question_candidates c
           WHERE c.owner_id = e.owner_id AND c.extraction_id = e.id AND c.status = 'discarded') AS discarded,
         (SELECT count(*) FROM study_question_candidates c
           WHERE c.owner_id = e.owner_id AND c.extraction_id = e.id AND c.status = 'draft'
             AND c.content->>'type' = 'open') AS open_drafts
    FROM study_question_extractions e
    LEFT JOIN study_material_versions v ON v.owner_id = e.owner_id AND v.id = e.version_id
    LEFT JOIN study_materials m ON m.owner_id = e.owner_id AND m.id = e.material_id`;

function toExtractionView(row: ExtractionRow, ready?: number): ExtractionView {
  const drafts = Number(row.drafts);
  const counts: ExtractionCounts = {
    total: Number(row.total),
    draft: drafts,
    committed: Number(row.committed),
    discarded: Number(row.discarded),
    // Lists approximate "ready" by kind; the detail view checks each draft.
    ready: ready ?? drafts - Number(row.open_drafts),
  };
  return {
    id: row.id,
    spaceId: row.space_id,
    materialId: row.material_id,
    versionId: row.version_id,
    versionNo: row.version_no === null ? null : Number(row.version_no),
    materialTitle: row.title,
    sourceAvailable: row.material_status === 'active' && row.linked,
    isCurrentVersion: row.current_version_id === row.version_id,
    artifactId: row.artifact_id,
    pageFrom: row.page_from === null ? null : Number(row.page_from),
    pageTo: row.page_to === null ? null : Number(row.page_to),
    strategy: row.strategy,
    stats: json<ExtractionStats>(row.stats)!,
    usage: { ...EMPTY_EXTRACTION_USAGE, ...(json<ExtractionUsage>(row.usage) ?? {}) },
    counts,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export async function listExtractions(
  db: Queryable,
  ownerId: string,
  spaceId: string,
): Promise<ExtractionView[]> {
  const result = await db.query<ExtractionRow>(
    `${EXTRACTION_SELECT}
      WHERE e.owner_id = $1 AND e.space_id = $2
      ORDER BY e.created_at DESC, e.id
      LIMIT 100`,
    [ownerId, spaceId],
  );
  return result.rows.map((row) => toExtractionView(row));
}

export async function getExtraction(
  db: Queryable,
  ownerId: string,
  extractionId: string,
  ready?: number,
): Promise<ExtractionView> {
  const result = await db.query<ExtractionRow>(
    `${EXTRACTION_SELECT} WHERE e.owner_id = $1 AND e.id = $2`,
    [ownerId, extractionId],
  );
  const row = result.rows[0];
  if (!row) throw new StudyError('STUDY_EXTRACTION_NOT_FOUND');
  return toExtractionView(row, ready);
}

export async function deleteExtraction(
  db: Queryable,
  ownerId: string,
  extractionId: string,
): Promise<void> {
  const result = await db.query(
    `DELETE FROM study_question_extractions WHERE owner_id = $1 AND id = $2 RETURNING id`,
    [ownerId, extractionId],
  );
  if (result.rows.length === 0) throw new StudyError('STUDY_EXTRACTION_NOT_FOUND');
}

/** Add the usage of one model-help request (and lock the row while doing so). */
export async function addExtractionUsage(
  tx: Queryable,
  ownerId: string,
  extractionId: string,
  delta: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    modelString: string;
    known: boolean;
  },
): Promise<void> {
  const current = await tx.query<{ usage: unknown }>(
    `SELECT usage FROM study_question_extractions WHERE owner_id = $1 AND id = $2 FOR UPDATE`,
    [ownerId, extractionId],
  );
  if (!current.rows[0]) throw new StudyError('STUDY_EXTRACTION_NOT_FOUND');
  const usage = {
    ...EMPTY_EXTRACTION_USAGE,
    ...(json<ExtractionUsage>(current.rows[0].usage) ?? {}),
  };
  const next: ExtractionUsage = {
    modelCalls: usage.modelCalls + delta.calls,
    inputTokens: usage.inputTokens + delta.inputTokens,
    outputTokens: usage.outputTokens + delta.outputTokens,
    modelString: delta.modelString,
    usageCompleteness:
      usage.usageCompleteness === 'partial' || !delta.known ? 'partial' : 'complete',
  };
  await tx.query(
    `UPDATE study_question_extractions SET usage = $3::jsonb, updated_at = clock_timestamp()
      WHERE owner_id = $1 AND id = $2`,
    [ownerId, extractionId, JSON.stringify(next)],
  );
}

export async function extractionModelCalls(
  db: Queryable,
  ownerId: string,
  extractionId: string,
): Promise<number> {
  const result = await db.query<{ usage: unknown }>(
    `SELECT usage FROM study_question_extractions WHERE owner_id = $1 AND id = $2`,
    [ownerId, extractionId],
  );
  if (!result.rows[0]) throw new StudyError('STUDY_EXTRACTION_NOT_FOUND');
  return json<ExtractionUsage>(result.rows[0].usage)?.modelCalls ?? 0;
}

// ── candidates ──────────────────────────────────────────────────────────────

interface CandidateRow extends Record<string, unknown> {
  id: string;
  extraction_id: string;
  position: number;
  status: CandidateStatus;
  label: string | null;
  section: string | null;
  content: unknown;
  original: unknown;
  source_lines: unknown;
  pages: number[];
  answer_basis: AnswerBasis;
  answer_ref: unknown;
  suggestion: unknown;
  checked: boolean;
  question_id: string | null;
  revision: number;
}

export interface StoredCandidate extends CandidateView {
  extractionId: string;
  original: CandidateOriginal;
}

const CANDIDATE_COLUMNS = `id, extraction_id, position, status, label, section, content, original,
  source_lines, pages, answer_basis, answer_ref, suggestion, checked, question_id, revision`;

function toCandidate(row: CandidateRow): StoredCandidate {
  const content = json<CandidateContent>(row.content)!;
  const original = json<CandidateOriginal>(row.original)!;
  return {
    id: row.id,
    extractionId: row.extraction_id,
    position: Number(row.position),
    status: row.status,
    label: row.label,
    section: row.section,
    content,
    lines: json<SourceLine[]>(row.source_lines) ?? [],
    pages: (row.pages ?? []).map(Number),
    answerBasis: row.answer_basis,
    answerRef: json<AnswerRef>(row.answer_ref),
    suggestion: json<CandidateSuggestion>(row.suggestion),
    checked: row.checked,
    questionId: row.question_id,
    revision: Number(row.revision),
    edited: JSON.stringify(content) !== JSON.stringify(original.content),
    original,
  };
}

export function candidateView(candidate: StoredCandidate): CandidateView {
  const { extractionId: _extraction, original: _original, ...view } = candidate;
  return view;
}

export async function listCandidates(
  db: Queryable,
  ownerId: string,
  extractionId: string,
): Promise<StoredCandidate[]> {
  const result = await db.query<CandidateRow>(
    `SELECT ${CANDIDATE_COLUMNS} FROM study_question_candidates
      WHERE owner_id = $1 AND extraction_id = $2
      ORDER BY position, id`,
    [ownerId, extractionId],
  );
  return result.rows.map(toCandidate);
}

export function readyCount(candidates: readonly StoredCandidate[]): number {
  return candidates.filter(
    (candidate) => candidate.status === 'draft' && isCommittable(candidate.content),
  ).length;
}

export async function getCandidate(
  db: Queryable,
  ownerId: string,
  candidateId: string,
  options: { forUpdate?: boolean } = {},
): Promise<StoredCandidate> {
  const result = await db.query<CandidateRow>(
    `SELECT ${CANDIDATE_COLUMNS} FROM study_question_candidates
      WHERE owner_id = $1 AND id = $2 ${options.forUpdate ? 'FOR UPDATE' : ''}`,
    [ownerId, candidateId],
  );
  const row = result.rows[0];
  if (!row) throw new StudyError('STUDY_CANDIDATE_NOT_FOUND');
  return toCandidate(row);
}

export interface CandidatePatch {
  content?: CandidateContent;
  answerBasis?: AnswerBasis;
  answerRef?: AnswerRef | null;
  suggestion?: CandidateSuggestion | null;
  status?: CandidateStatus;
  checked?: boolean;
  questionId?: string | null;
}

/** Apply a change to a candidate the caller locked; bumps the revision. */
export async function writeCandidate(
  tx: Queryable,
  ownerId: string,
  candidate: StoredCandidate,
  patch: CandidatePatch,
): Promise<void> {
  await tx.query(
    `UPDATE study_question_candidates
        SET content = $3::jsonb, answer_basis = $4, answer_ref = $5::jsonb, suggestion = $6::jsonb,
            status = $7, checked = $8, question_id = $9, revision = revision + 1,
            updated_at = clock_timestamp()
      WHERE owner_id = $1 AND id = $2`,
    [
      ownerId,
      candidate.id,
      JSON.stringify(patch.content ?? candidate.content),
      patch.answerBasis ?? candidate.answerBasis,
      patch.answerRef === undefined
        ? candidate.answerRef
          ? JSON.stringify(candidate.answerRef)
          : null
        : patch.answerRef
          ? JSON.stringify(patch.answerRef)
          : null,
      patch.suggestion === undefined
        ? candidate.suggestion
          ? JSON.stringify(candidate.suggestion)
          : null
        : patch.suggestion
          ? JSON.stringify(patch.suggestion)
          : null,
      patch.status ?? candidate.status,
      patch.checked ?? candidate.checked,
      patch.questionId === undefined ? candidate.questionId : patch.questionId,
    ],
  );
  await tx.query(
    `UPDATE study_question_extractions SET updated_at = clock_timestamp()
      WHERE owner_id = $1 AND id = $2`,
    [ownerId, candidate.extractionId],
  );
}

/**
 * Replace some candidates of an extraction with new ones at the position of
 * the first (split/merge), then renumber the extraction 1…n.
 */
export async function replaceCandidates(
  tx: Queryable,
  ownerId: string,
  extractionId: string,
  removeIds: readonly string[],
  replacements: readonly NewCandidate[],
): Promise<void> {
  const positions = await tx.query<{ position: number }>(
    `SELECT min(position) AS position FROM study_question_candidates
      WHERE owner_id = $1 AND extraction_id = $2 AND id = ANY($3::text[])`,
    [ownerId, extractionId, [...removeIds]],
  );
  const at = Number(positions.rows[0]?.position ?? 1);
  await tx.query(
    `DELETE FROM study_question_candidates
      WHERE owner_id = $1 AND extraction_id = $2 AND id = ANY($3::text[])`,
    [ownerId, extractionId, [...removeIds]],
  );
  // Make room after the replaced slot, insert, then close any gaps.
  await tx.query(
    `UPDATE study_question_candidates SET position = position + $4
      WHERE owner_id = $1 AND extraction_id = $2 AND position >= $3`,
    [ownerId, extractionId, at, replacements.length],
  );
  await insertCandidates(tx, ownerId, extractionId, replacements, at);
  await tx.query(
    `UPDATE study_question_candidates c SET position = ordered.n
       FROM (SELECT id, row_number() OVER (ORDER BY position, id) AS n
               FROM study_question_candidates
              WHERE owner_id = $1 AND extraction_id = $2) ordered
      WHERE c.owner_id = $1 AND c.id = ordered.id AND c.position <> ordered.n`,
    [ownerId, extractionId],
  );
  await tx.query(
    `UPDATE study_question_extractions SET updated_at = clock_timestamp()
      WHERE owner_id = $1 AND id = $2`,
    [ownerId, extractionId],
  );
}
