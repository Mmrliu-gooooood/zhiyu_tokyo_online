/**
 * Exercise extraction operations (learning plan B08): start an extraction
 * from a parsed material version, review and correct its candidates (edit,
 * restore, adopt a model suggestion, split, merge, discard) and commit them
 * to the question bank.
 *
 * - Only text the B02 parse produced is read. Pages without text (scanned)
 *   are listed as skipped; nothing is guessed and no OCR is called.
 * - The same request (version, parse result, page range, strategy) returns
 *   the same extraction, so repeating it adds nothing.
 * - Committing needs the material to be still in the library and linked to
 *   the space: a deleted or unlinked material allows no new questions.
 * - A committed question is `material_extracted`, points at the material
 *   version and file pages it came from, keeps where its answer came from,
 *   and is checked only when the student ticked it.
 */
import { createHash } from 'node:crypto';

import type { Queryable } from '@openmaic/storage/document/pg';

import { resolveStudyVersion } from '@/lib/server/study/materials/repository';
import { loadArtifactDocument } from '@/lib/server/study/materials/service';
import type { StoredArtifactDocument } from '@/lib/server/study/materials/artifact';
import {
  assertSpaceCourse,
  insertQuestions,
  requireQuestionSpace,
  type NewQuestion,
} from '@/lib/server/study/questions/repository';
import { StudyError, type StudyDb } from '@/lib/server/study/spaces/repository';
import {
  candidateQuestion,
  isCommittable,
  mergeConcepts,
  parseCandidateContent,
  sameAnswer,
} from '@/lib/study/extraction/candidate';
import {
  EXTRACTION_LIMITS,
  EXTRACTION_STRATEGY,
  type CandidateContent,
  type CandidateView,
  type CommitOutcome,
  type ExtractionDetail,
  type ExtractionStats,
  type ExtractionView,
  type SourceLine,
} from '@/lib/study/extraction/contracts';
import {
  extractQuestions,
  mentionsFigure,
  parseBlock,
  type PageImage,
  type PageText,
} from '@/lib/study/extraction/rules';
import type { QuestionFigure, QuestionSource } from '@/lib/study/questions/contracts';

import {
  candidateView,
  countExtractions,
  createCandidateId,
  createExtractionId,
  findExtractionByKey,
  getCandidate,
  getExtraction,
  insertExtraction,
  listCandidates,
  listExtractions,
  readyCount,
  replaceCandidates,
  writeCandidate,
  type NewCandidate,
  type StoredCandidate,
} from './repository';

// ── reading the parse result ────────────────────────────────────────────────

/** Text of each page in the range (null: no text) and the figures on those pages. */
export function pagesOf(
  document: StoredArtifactDocument,
  range: { from: number; to: number } | null,
): { pages: PageText[]; images: PageImage[] } {
  const textOf = (blocks: StoredArtifactDocument['blocks']) =>
    blocks
      .flatMap((block) => {
        if (block.type === 'text' || block.type === 'markdown')
          return block.text ? [block.text] : [];
        if (block.type === 'table' && block.cells) {
          return [block.cells.map((row) => row.join('  ')).join('\n')];
        }
        return [];
      })
      .join('\n');
  if (!range) {
    const text = textOf(document.blocks);
    return {
      pages: [{ page: 1, text: text.trim() ? text : null }],
      images: document.images.map((image) => ({ id: image.id, page: 1 })),
    };
  }
  const pages: PageText[] = [];
  for (let page = range.from; page <= range.to; page += 1) {
    const text = textOf(document.blocks.filter((block) => block.pageNumber === page));
    pages.push({ page, text: text.trim() ? text : null });
  }
  return {
    pages,
    images: document.images
      .filter(
        (image) =>
          image.pageNumber !== undefined &&
          image.pageNumber >= range.from &&
          image.pageNumber <= range.to,
      )
      .map((image) => ({ id: image.id, page: image.pageNumber! })),
  };
}

function requestKeyOf(input: {
  versionId: string;
  artifactId: string;
  range: { from: number; to: number } | null;
}): string {
  return createHash('sha256')
    .update(
      [
        input.versionId,
        input.artifactId,
        input.range ? `${input.range.from}-${input.range.to}` : 'all',
        EXTRACTION_STRATEGY,
      ].join('|'),
    )
    .digest('hex');
}

async function assertSpaceMaterial(
  db: Queryable,
  ownerId: string,
  spaceId: string,
  materialId: string,
): Promise<string | null> {
  const result = await db.query<{ current_version_id: string | null }>(
    `SELECT m.current_version_id
       FROM study_space_materials l
       JOIN study_materials m ON m.owner_id = l.owner_id AND m.id = l.material_id
      WHERE l.owner_id = $1 AND l.space_id = $2 AND l.material_id = $3 AND m.status = 'active'`,
    [ownerId, spaceId, materialId],
  );
  if (!result.rows[0]) throw new StudyError('STUDY_MATERIAL_NOT_FOUND');
  return result.rows[0].current_version_id;
}

async function artifactDocument(
  db: Queryable,
  ownerId: string,
  artifactId: string,
): Promise<StoredArtifactDocument> {
  const result = await db.query<{ artifact_key: string }>(
    `SELECT artifact_key FROM study_material_artifacts WHERE owner_id = $1 AND id = $2`,
    [ownerId, artifactId],
  );
  if (!result.rows[0]) throw new StudyError('STUDY_EXTRACTION_SOURCE_GONE');
  return loadArtifactDocument(result.rows[0].artifact_key);
}

// ── starting ────────────────────────────────────────────────────────────────

export interface StartExtractionInput {
  spaceId: string;
  materialId: string;
  /** Default: the material's current version. */
  versionId: string | null;
  pageFrom: number | null;
  pageTo: number | null;
}

function newCandidate(parsed: Omit<NewCandidate, 'id' | 'original'>): NewCandidate {
  return {
    ...parsed,
    id: createCandidateId(),
    original: {
      content: structuredClone(parsed.content),
      answerBasis: parsed.answerBasis,
      answerRef: parsed.answerRef,
    },
  };
}

export async function startExtraction(
  db: StudyDb,
  ownerId: string,
  input: StartExtractionInput,
): Promise<{ extractionId: string; created: boolean }> {
  await requireQuestionSpace(db, ownerId, input.spaceId, { writable: true });
  const currentVersionId = await assertSpaceMaterial(db, ownerId, input.spaceId, input.materialId);
  const versionId = input.versionId ?? currentVersionId;
  if (!versionId) throw new StudyError('STUDY_MATERIAL_NOT_PARSED');
  const version = await resolveStudyVersion(db, ownerId, input.materialId, versionId);
  if (!version.artifact) throw new StudyError('STUDY_MATERIAL_NOT_PARSED');
  const document = await loadArtifactDocument(version.artifact.artifactKey);

  let range: { from: number; to: number } | null = null;
  if (document.paged) {
    const pageCount = Math.max(1, document.pageCount);
    const from = input.pageFrom ?? 1;
    const to = input.pageTo ?? Math.min(pageCount, from + EXTRACTION_LIMITS.maxPages - 1);
    if (
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      from < 1 ||
      to < from ||
      to > pageCount ||
      to - from + 1 > EXTRACTION_LIMITS.maxPages
    ) {
      throw new StudyError('STUDY_EXTRACTION_RANGE_INVALID', {
        pageCount,
        maxPages: EXTRACTION_LIMITS.maxPages,
      });
    }
    range = { from, to };
  }
  const requestKey = requestKeyOf({
    versionId: version.versionId,
    artifactId: version.artifact.artifactId,
    range,
  });
  const existing = await findExtractionByKey(db, ownerId, input.spaceId, requestKey);
  if (existing) return { extractionId: existing, created: false };
  if (
    (await countExtractions(db, ownerId, input.spaceId)) >= EXTRACTION_LIMITS.extractionsPerSpace
  ) {
    throw new StudyError('STUDY_EXTRACTION_LIMIT');
  }

  const startedAt = performance.now();
  const { pages, images } = pagesOf(document, range);
  const result = extractQuestions(pages, images);
  const stats: ExtractionStats = {
    ...result.stats,
    pageCount: document.paged ? document.pageCount : 1,
    durationMs: Math.round(performance.now() - startedAt),
    extractorId: version.artifact.extractorId,
  };
  const candidates = result.candidates.map((candidate) =>
    newCandidate({
      label: candidate.label,
      section: candidate.section,
      content: candidate.content,
      lines: candidate.lines,
      pages: candidate.pages,
      answerBasis: candidate.answerBasis,
      answerRef: candidate.answerRef,
    }),
  );
  const outcome = await db.withTransaction((tx) =>
    insertExtraction(
      tx,
      ownerId,
      {
        id: createExtractionId(),
        spaceId: input.spaceId,
        materialId: input.materialId,
        versionId: version.versionId,
        artifactId: version.artifact!.artifactId,
        pageFrom: range?.from ?? null,
        pageTo: range?.to ?? null,
        strategy: EXTRACTION_STRATEGY,
        requestKey,
        stats,
      },
      candidates,
    ),
  );
  return { extractionId: outcome.id, created: outcome.created };
}

// ── reading ─────────────────────────────────────────────────────────────────

export async function listSpaceExtractions(
  db: Queryable,
  ownerId: string,
  spaceId: string,
): Promise<ExtractionView[]> {
  await requireQuestionSpace(db, ownerId, spaceId, { writable: false });
  return listExtractions(db, ownerId, spaceId);
}

export async function extractionDetail(
  db: Queryable,
  ownerId: string,
  extractionId: string,
): Promise<ExtractionDetail> {
  const candidates = await listCandidates(db, ownerId, extractionId);
  const extraction = await getExtraction(db, ownerId, extractionId, readyCount(candidates));
  return { extraction, candidates: candidates.map(candidateView) };
}

// ── editing ─────────────────────────────────────────────────────────────────

async function lockDraft(
  tx: Queryable,
  ownerId: string,
  candidateId: string,
  revision: number,
): Promise<StoredCandidate> {
  const candidate = await getCandidate(tx, ownerId, candidateId, { forUpdate: true });
  if (candidate.revision !== revision) {
    throw new StudyError('STUDY_REVISION_CONFLICT', { candidate: candidateView(candidate) });
  }
  if (candidate.status === 'committed') {
    throw new StudyError('STUDY_CANDIDATE_INVALID', { reason: 'committed' });
  }
  return candidate;
}

/** The answer's evidence after an edit: unchanged keeps it, a change is the student's. */
function basisAfterEdit(current: StoredCandidate, content: CandidateContent) {
  const same =
    content.type === 'open'
      ? (content.referenceAnswer ?? '') === (current.content.referenceAnswer ?? '') &&
        current.content.type === 'open'
      : sameAnswer(content.answer, current.content.answer) && current.content.type !== 'open';
  if (same) return { answerBasis: current.answerBasis, answerRef: current.answerRef };
  const has =
    content.type === 'open' ? Boolean(content.referenceAnswer) : content.answer.length > 0;
  return { answerBasis: has ? ('user' as const) : ('missing' as const), answerRef: null };
}

export interface CandidateUpdate {
  revision: number;
  content?: unknown;
  checked?: boolean;
  status?: 'draft' | 'discarded';
}

export async function updateCandidate(
  db: StudyDb,
  ownerId: string,
  candidateId: string,
  update: CandidateUpdate,
): Promise<CandidateView> {
  await db.withTransaction(async (tx) => {
    const candidate = await lockDraft(tx, ownerId, candidateId, update.revision);
    let content: CandidateContent | undefined;
    if (update.content !== undefined) {
      const figures = (update.content as { figures?: unknown })?.figures;
      const sameFigures =
        JSON.stringify(figures ?? []) === JSON.stringify(candidate.content.figures);
      const extraction = await getExtraction(tx, ownerId, candidate.extractionId);
      const allowed = sameFigures
        ? new Set(candidate.content.figures)
        : new Set(
            (await artifactDocument(tx, ownerId, extraction.artifactId)).images.map(
              (image) => image.id,
            ),
          );
      const parsed = parseCandidateContent(update.content, allowed);
      if (!parsed.content)
        throw new StudyError('STUDY_CANDIDATE_INVALID', { issues: parsed.issues });
      content = parsed.content;
    }
    await writeCandidate(tx, ownerId, candidate, {
      ...(content ? { content, ...basisAfterEdit(candidate, content) } : {}),
      ...(update.checked !== undefined ? { checked: update.checked } : {}),
      ...(update.status ? { status: update.status } : {}),
    });
  });
  return candidateView(await getCandidate(db, ownerId, candidateId));
}

/** Back to what the extractor produced (the model suggestion stays available). */
export async function restoreCandidate(
  db: StudyDb,
  ownerId: string,
  candidateId: string,
  revision: number,
): Promise<CandidateView> {
  await db.withTransaction(async (tx) => {
    const candidate = await lockDraft(tx, ownerId, candidateId, revision);
    await writeCandidate(tx, ownerId, candidate, {
      content: candidate.original.content,
      answerBasis: candidate.original.answerBasis,
      answerRef: candidate.original.answerRef,
      checked: false,
    });
  });
  return candidateView(await getCandidate(db, ownerId, candidateId));
}

/**
 * Take the model's suggestion: its tidied stem/options and, when the
 * candidate has no answer (or a different one), its answer — recorded as
 * `model`, never as checked.
 */
export async function adoptSuggestion(
  db: StudyDb,
  ownerId: string,
  candidateId: string,
  revision: number,
): Promise<CandidateView> {
  await db.withTransaction(async (tx) => {
    const candidate = await lockDraft(tx, ownerId, candidateId, revision);
    const suggestion = candidate.suggestion;
    if (!suggestion) throw new StudyError('STUDY_CANDIDATE_INVALID', { reason: 'no_suggestion' });
    const current = candidate.content;
    const type = suggestion.type ?? current.type;
    const options = type === 'open' ? [] : (suggestion.options ?? current.options);
    const answer =
      type === 'open' ? [] : suggestion.answer.length ? suggestion.answer : current.answer;
    // The model's reasoning comes along only with the model's own answer, which
    // is then labelled as a model suggestion; it never explains a printed one.
    const modelAnswer = answer.length > 0 && !sameAnswer(answer, current.answer);
    const parsed = parseCandidateContent(
      {
        ...current,
        type,
        stem: suggestion.stem ?? current.stem,
        options,
        answer,
        explanation: current.explanation ?? (modelAnswer ? suggestion.explanation : null),
      },
      new Set(current.figures),
    );
    if (!parsed.content) throw new StudyError('STUDY_CANDIDATE_INVALID', { issues: parsed.issues });
    const content = parsed.content;
    const answerChanged = !sameAnswer(content.answer, current.answer) || type !== current.type;
    await writeCandidate(tx, ownerId, candidate, {
      content,
      ...(answerChanged
        ? {
            answerBasis: content.answer.length ? 'model' : 'missing',
            answerRef: null,
            checked: false,
          }
        : {}),
    });
  });
  return candidateView(await getCandidate(db, ownerId, candidateId));
}

function figurePages(document: StoredArtifactDocument): Map<string, number> {
  return new Map(
    document.images.flatMap((image) =>
      image.pageNumber !== undefined ? [[image.id, image.pageNumber] as const] : [],
    ),
  );
}

/** Re-read lines into a candidate, keeping an earlier printed answer that still fits. */
function rebuild(
  lines: SourceLine[],
  base: { label: string | null; section: string | null },
  carried: StoredCandidate[],
  figures: string[],
): NewCandidate {
  const parsed = parseBlock(lines);
  const content = parsed.content;
  let answerBasis: NewCandidate['answerBasis'] = parsed.answerRef ? 'source' : 'missing';
  let answerRef = parsed.answerRef;
  if (!answerRef && content.type !== 'open') {
    const donor = carried.find(
      (candidate) =>
        candidate.content.answer.length > 0 &&
        candidate.content.answer.every((value) =>
          content.options.some((option) => option.value === value),
        ),
    );
    if (donor) {
      content.answer = [...donor.content.answer];
      if (content.answer.length > 1) content.type = 'multiple';
      answerBasis = donor.answerBasis;
      answerRef = donor.answerRef;
    }
  }
  content.figures = figures.slice(0, EXTRACTION_LIMITS.figuresPerQuestion);
  content.concepts = mergeConcepts(
    carried.flatMap((candidate) => candidate.content.concepts),
    [],
  ).slice(0, 8);
  return newCandidate({
    label: parsed.label ?? base.label,
    section: base.section,
    content,
    lines,
    pages: [...new Set(lines.map((line) => line.page))],
    answerBasis,
    answerRef,
  });
}

/** Split one candidate in two before line `atLine` (both parts are read again). */
export async function splitCandidate(
  db: StudyDb,
  ownerId: string,
  candidateId: string,
  input: { revision: number; atLine: number },
): Promise<ExtractionDetail> {
  const extractionId = await db.withTransaction(async (tx) => {
    const candidate = await lockDraft(tx, ownerId, candidateId, input.revision);
    if (
      !Number.isInteger(input.atLine) ||
      input.atLine < 1 ||
      input.atLine >= candidate.lines.length
    ) {
      throw new StudyError('STUDY_CANDIDATE_INVALID', { reason: 'split_line' });
    }
    const extraction = await getExtraction(tx, ownerId, candidate.extractionId);
    const pageOf = candidate.content.figures.length
      ? figurePages(await artifactDocument(tx, ownerId, extraction.artifactId))
      : new Map<string, number>();
    const first = candidate.lines.slice(0, input.atLine);
    const second = candidate.lines.slice(input.atLine);
    const secondPages = new Set(second.map((line) => line.page));
    const firstPages = new Set(first.map((line) => line.page));
    const secondClaims = mentionsFigure(second.map((line) => line.text).join(''));
    const toSecond = (id: string) => {
      const page = pageOf.get(id);
      if (page === undefined || !secondPages.has(page)) return false;
      return !firstPages.has(page) || secondClaims;
    };
    // The printed answer stays with the part whose options it fits.
    const firstPart = rebuild(
      first,
      candidate,
      [candidate],
      candidate.content.figures.filter((id) => !toSecond(id)),
    );
    const secondPart = rebuild(
      second,
      { label: null, section: candidate.section },
      firstPart.content.answer.length ? [] : [candidate],
      candidate.content.figures.filter(toSecond),
    );
    await replaceCandidates(
      tx,
      ownerId,
      candidate.extractionId,
      [candidate.id],
      [firstPart, secondPart],
    );
    return candidate.extractionId;
  });
  return extractionDetail(db, ownerId, extractionId);
}

/** Merge a candidate with the next one (a question cut in two by the extractor). */
export async function mergeWithNext(
  db: StudyDb,
  ownerId: string,
  candidateId: string,
  revision: number,
): Promise<ExtractionDetail> {
  const extractionId = await db.withTransaction(async (tx) => {
    const candidate = await lockDraft(tx, ownerId, candidateId, revision);
    const next = (await listCandidates(tx, ownerId, candidate.extractionId)).find(
      (other) => other.position > candidate.position,
    );
    if (!next || next.status === 'committed') {
      throw new StudyError('STUDY_CANDIDATE_INVALID', { reason: 'no_next' });
    }
    await getCandidate(tx, ownerId, next.id, { forUpdate: true });
    const lines = [...candidate.lines, ...next.lines].slice(
      0,
      EXTRACTION_LIMITS.linesPerCandidate * 2,
    );
    const figures = [...new Set([...candidate.content.figures, ...next.content.figures])];
    await replaceCandidates(
      tx,
      ownerId,
      candidate.extractionId,
      [candidate.id, next.id],
      [rebuild(lines, candidate, [candidate, next], figures)],
    );
    return candidate.extractionId;
  });
  return extractionDetail(db, ownerId, extractionId);
}

// ── committing ──────────────────────────────────────────────────────────────

function linesFingerprint(versionId: string, lines: readonly SourceLine[]): string {
  const digest = createHash('sha256')
    .update(lines.map((line) => `${line.page}:${line.text}`).join('\n'))
    .digest('hex')
    .slice(0, 32);
  return `mat:${versionId}/${digest}`;
}

export async function commitCandidates(
  db: StudyDb,
  ownerId: string,
  extractionId: string,
  input: { candidateIds: readonly string[]; stageId: string | null },
): Promise<{ outcomes: CommitOutcome[]; detail: ExtractionDetail }> {
  const extraction = await getExtraction(db, ownerId, extractionId);
  if (!extraction.sourceAvailable || extraction.versionNo === null) {
    throw new StudyError('STUDY_EXTRACTION_SOURCE_GONE');
  }
  await requireQuestionSpace(db, ownerId, extraction.spaceId, { writable: true });
  if (input.stageId) await assertSpaceCourse(db, ownerId, extraction.spaceId, input.stageId);
  const all = await listCandidates(db, ownerId, extractionId);
  const byId = new Map(all.map((candidate) => [candidate.id, candidate]));
  const wanted = [...new Set(input.candidateIds)];
  if (wanted.some((id) => !byId.has(id))) throw new StudyError('STUDY_CANDIDATE_NOT_FOUND');

  const outcomes = new Map<string, CommitOutcome>();
  const writes: Array<{ candidate: StoredCandidate; question: NewQuestion }> = [];
  for (const id of wanted) {
    const candidate = byId.get(id)!;
    if (candidate.status === 'committed') {
      outcomes.set(id, { candidateId: id, status: 'skipped', questionId: candidate.questionId });
      continue;
    }
    const question = candidateQuestion(candidate.content);
    if (candidate.status !== 'draft' || !question || !isCommittable(candidate.content)) {
      outcomes.set(id, { candidateId: id, status: 'invalid', questionId: null });
      continue;
    }
    const source: QuestionSource = {
      title: (extraction.materialTitle ?? '').slice(0, 200) || undefined,
      material: {
        materialId: extraction.materialId,
        versionId: extraction.versionId,
        versionNo: extraction.versionNo,
        artifactId: extraction.artifactId,
        pages: candidate.pages,
        label: candidate.label,
      },
      ...(candidate.answerBasis === 'source' || candidate.answerBasis === 'model'
        ? { answerBasis: candidate.answerBasis }
        : {}),
    };
    if (!source.title) delete source.title;
    const figures: QuestionFigure[] = candidate.content.figures.map((imageId) => ({
      materialId: extraction.materialId,
      versionId: extraction.versionId,
      artifactId: extraction.artifactId,
      imageId,
    }));
    writes.push({
      candidate,
      question: {
        content: { ...question, source, ...(figures.length ? { figures } : {}) },
        verification:
          candidate.checked && question.answer.length > 0 ? 'user_verified' : 'unverified',
        origin: 'material_extracted',
        fingerprint: linesFingerprint(extraction.versionId, candidate.lines),
        stageId: input.stageId,
      },
    });
  }
  for (let start = 0; start < writes.length; start += EXTRACTION_LIMITS.commitBatch) {
    const batch = writes.slice(start, start + EXTRACTION_LIMITS.commitBatch);
    const inserted = await insertQuestions(
      db,
      ownerId,
      extraction.spaceId,
      batch.map((write) => write.question),
    );
    await db.withTransaction(async (tx) => {
      for (const [index, outcome] of inserted.entries()) {
        const { candidate } = batch[index]!;
        outcomes.set(candidate.id, {
          candidateId: candidate.id,
          status: outcome.status,
          questionId: outcome.id,
        });
        if (!outcome.id) continue;
        const locked = await getCandidate(tx, ownerId, candidate.id, { forUpdate: true });
        if (locked.status !== 'draft') continue;
        await writeCandidate(tx, ownerId, locked, { status: 'committed', questionId: outcome.id });
      }
    });
  }
  return {
    outcomes: wanted.map((id) => outcomes.get(id)!),
    detail: await extractionDetail(db, ownerId, extractionId),
  };
}
