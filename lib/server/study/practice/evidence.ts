/**
 * Evidence for AI practice questions (learning plan B11): passages of the
 * subject's own materials, current versions with a usable index (the B03
 * scope, computed here and never taken from the client), frozen with the
 * job. Retrieval is keyword-only — no embedding or other model call —
 * topped up with passages spread evenly through each material when the
 * keywords find too little. Variants also carry the original question.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import { knowledgeReadiness } from '@/lib/server/study/knowledge/service';
import { questionTerms } from '@/lib/server/study/knowledge/query-terms';
import {
  knowledgeStorageReady,
  resolveQuestionScope,
  searchStudyKnowledge,
  type ScopedIndex,
} from '@/lib/server/study/knowledge/repository';
import { StudyError, type StudyDb } from '@/lib/server/study/spaces/repository';
import {
  PRACTICE_LIMITS,
  type PracticeEvidence,
  type PracticeMaterial,
} from '@/lib/study/practice/contracts';
import type { WrongQuestion } from '@/lib/study/wrongbook/contracts';

/** The scope signature, or null when material retrieval is unavailable here. */
export async function retrievalSignature(db: StudyDb): Promise<string | null> {
  const readiness = await knowledgeReadiness(db);
  return readiness.storage && readiness.signature ? readiness.signature : null;
}

/** The subject's materials questions may be written from (current indexed versions). */
export async function practiceScope(
  db: Queryable,
  ownerId: string,
  spaceId: string,
  signature: string | null,
): Promise<ScopedIndex[]> {
  if (!signature || !(await knowledgeStorageReady(db))) return [];
  return resolveQuestionScope(db, ownerId, spaceId, signature, []);
}

export function materialsOf(scope: readonly ScopedIndex[]): PracticeMaterial[] {
  return scope.map((index) => ({
    materialId: index.materialId,
    versionId: index.versionId,
    versionNo: index.versionNo,
    title: index.title,
  }));
}

/** Narrow the scope to the versions the student kept (all of them when none named). */
export function narrowScope(
  scope: readonly ScopedIndex[],
  versionIds: readonly string[] | null,
): ScopedIndex[] {
  if (!versionIds || versionIds.length === 0) {
    return scope.slice(0, PRACTICE_LIMITS.materialVersions);
  }
  const wanted = new Set(versionIds);
  const narrowed = scope.filter((index) => wanted.has(index.versionId));
  if (narrowed.length !== wanted.size || narrowed.length > PRACTICE_LIMITS.materialVersions) {
    throw new StudyError('STUDY_PRACTICE_INVALID', { field: 'materialVersionIds' });
  }
  return narrowed;
}

interface Passage {
  index: ScopedIndex;
  chunkId: string;
  blockId: string;
  page: number | null;
  text: string;
  contentHash: string;
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Passages spread evenly through each material (when the keywords found too few). */
async function spreadPassages(
  db: Queryable,
  ownerId: string,
  scope: readonly ScopedIndex[],
  perIndex: number,
): Promise<Passage[]> {
  const passages: Passage[] = [];
  for (const index of scope) {
    const count = await db.query<{ n: string | number }>(
      `SELECT count(*) AS n FROM study_knowledge_chunks
        WHERE owner_id = $1 AND index_id = $2 AND char_length(text) >= 60`,
      [ownerId, index.indexId],
    );
    const total = Number(count.rows[0]?.n ?? 0);
    if (total === 0) continue;
    const step = Math.max(1, Math.floor(total / perIndex));
    const rows = await db.query<{
      id: string;
      block_id: string;
      page_number: number | null;
      text: string;
      content_hash: string;
    }>(
      `SELECT id, block_id, page_number, text, content_hash FROM (
         SELECT id, block_id, page_number, text, content_hash, ordinal,
                row_number() OVER (ORDER BY ordinal) - 1 AS n
           FROM study_knowledge_chunks
          WHERE owner_id = $1 AND index_id = $2 AND char_length(text) >= 60
       ) c
       WHERE n % $3 = 0
       ORDER BY ordinal
       LIMIT $4`,
      [ownerId, index.indexId, step, perIndex],
    );
    for (const row of rows.rows) {
      passages.push({
        index,
        chunkId: row.id,
        blockId: row.block_id,
        page: row.page_number === null ? null : Number(row.page_number),
        text: row.text,
        contentHash: row.content_hash,
      });
    }
  }
  return passages;
}

function toEvidence(passages: readonly Passage[], limit: number): PracticeEvidence[] {
  const evidence: PracticeEvidence[] = [];
  const seen = new Set<string>();
  let chars = 0;
  for (const passage of passages) {
    if (evidence.length >= limit) break;
    const key = `${passage.index.indexId}\u0000${passage.chunkId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const text = clip(passage.text, PRACTICE_LIMITS.passageChars);
    if (chars + text.length > PRACTICE_LIMITS.evidenceChars && evidence.length > 0) break;
    chars += text.length;
    evidence.push({
      id: `E${evidence.length + 1}`,
      kind: 'material',
      text,
      materialId: passage.index.materialId,
      versionId: passage.index.versionId,
      versionNo: passage.index.versionNo,
      artifactId: passage.index.artifactId,
      page: passage.page,
      blockId: passage.blockId,
      title: passage.index.title,
      contentHash: passage.contentHash,
    });
  }
  return evidence;
}

async function keywordPassages(
  db: Queryable,
  ownerId: string,
  scope: readonly ScopedIndex[],
  text: string,
  k: number,
): Promise<Passage[]> {
  const terms = questionTerms(text);
  if (terms.length === 0) return [];
  const hits = await searchStudyKnowledge(db, ownerId, scope, terms, null, k);
  return hits.map((hit) => ({
    index: hit.index,
    chunkId: hit.chunkId,
    blockId: hit.blockId,
    page: hit.pageNumber,
    text: hit.text,
    contentHash: hit.contentHash,
  }));
}

/** Evidence for a paper job: keyword hits for the knowledge points and course, then spread passages. */
export async function paperEvidence(
  db: Queryable,
  ownerId: string,
  scope: readonly ScopedIndex[],
  query: string,
): Promise<PracticeEvidence[]> {
  if (scope.length === 0) return [];
  const limit = PRACTICE_LIMITS.evidencePassages;
  const found = await keywordPassages(db, ownerId, scope, query, limit);
  const passages = [...found];
  if (passages.length < limit) {
    const perIndex = Math.max(2, Math.ceil((limit - passages.length) / scope.length));
    passages.push(...(await spreadPassages(db, ownerId, scope, perIndex)));
  }
  return toEvidence(passages, limit);
}

/** The original question as evidence `Q0` (stem, options, key and explanation as asked). */
export function originalEvidence(question: WrongQuestion): PracticeEvidence {
  const lines = [`题干：${question.stem}`];
  if (question.options.length) {
    lines.push(
      `选项：${question.options.map((option) => `${option.value}. ${option.label}`).join('；')}`,
    );
  }
  if (question.answer.length) lines.push(`正确答案：${question.answer.join('、')}`);
  if (question.reference) lines.push(`参考答案：${question.reference}`);
  if (question.finalAnswer) lines.push(`最终答案：${question.finalAnswer}`);
  if (question.explanation) lines.push(`解析：${question.explanation}`);
  return { id: 'Q0', kind: 'question', text: clip(lines.join('\n'), 2500) };
}

/** Evidence for a variant job: the original question and a few passages that match it. */
export async function variantEvidence(
  db: Queryable,
  ownerId: string,
  scope: readonly ScopedIndex[],
  question: WrongQuestion,
): Promise<PracticeEvidence[]> {
  const evidence: PracticeEvidence[] = [originalEvidence(question)];
  if (scope.length === 0) return evidence;
  const found = await keywordPassages(
    db,
    ownerId,
    scope,
    `${question.concepts.join(' ')} ${question.stem}`.slice(0, 600),
    4,
  );
  return [...evidence, ...toEvidence(found, 4)];
}
