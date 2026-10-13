/**
 * Question bank operations (learning plan B07): import preview and commit,
 * manual questions, edits and private copies of official pack questions.
 * Every write re-validates on the server; nothing the client says about a
 * question (gradable, duplicate, verified state of an official pack) is taken
 * on trust.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import { StudyError, type StudyDb } from '@/lib/server/study/spaces/repository';
import {
  blockingIssues,
  hasAnswerKey,
  packFingerprint,
  parseImportDocument,
  parseQuestion,
  QUESTION_LIMITS,
  type ImportCommitResult,
  type ImportPreview,
  type ImportPreviewItem,
  type QuestionContent,
  type QuestionSource,
  type QuestionView,
  type VerificationState,
} from '@/lib/study/questions/contracts';
import { findPack, packQuestionContent } from '@/lib/study/questions/packs';

import {
  assertSpaceCourse,
  getQuestion,
  insertQuestions,
  questionContentHash,
  requireQuestionSpace,
  updateQuestion,
  type InsertOutcome,
} from './repository';

/** For validated content: a draft (no answer key or grading guide) is never recorded as checked. */
function verificationFor(content: QuestionContent, verified: boolean): VerificationState {
  return verified && hasAnswerKey(content) ? 'user_verified' : 'unverified';
}

async function existingByHash(
  db: Queryable,
  ownerId: string,
  spaceId: string,
  hashes: readonly string[],
): Promise<Map<string, string>> {
  if (hashes.length === 0) return new Map();
  const result = await db.query<{ id: string; source_fingerprint: string; content_hash: string }>(
    `SELECT q.id, q.source_fingerprint, v.content_hash
       FROM study_questions q
       JOIN study_question_versions v
         ON v.owner_id = q.owner_id AND v.question_id = q.id AND v.version = q.current_version
      WHERE q.owner_id = $1 AND q.space_id = $2
        AND (q.source_fingerprint = ANY($3::text[]) OR v.content_hash = ANY($3::text[]))`,
    [ownerId, spaceId, [...hashes]],
  );
  const map = new Map<string, string>();
  for (const row of result.rows) {
    map.set(row.source_fingerprint, row.id);
    map.set(row.content_hash, row.id);
  }
  return map;
}

/** Validate a whole file and mark duplicates; writes nothing. */
export async function previewImport(
  db: Queryable,
  ownerId: string,
  spaceId: string,
  document: unknown,
): Promise<ImportPreview> {
  await requireQuestionSpace(db, ownerId, spaceId, { writable: true });
  const parsed = parseImportDocument(document);
  if (parsed.fileError) throw new StudyError('STUDY_IMPORT_INVALID', { reason: parsed.fileError });
  const hashes = parsed.items.map((item) =>
    item.content ? questionContentHash(item.content) : '',
  );
  const existing = await existingByHash(db, ownerId, spaceId, hashes.filter(Boolean));
  const firstIndex = new Map<string, number>();
  const items = parsed.items.map((item, index): ImportPreviewItem => {
    const errors = blockingIssues(item.issues);
    const warnings = item.issues.filter((issue) => !errors.includes(issue));
    const hash = hashes[index]!;
    let duplicateOf: string | null = null;
    if (hash && errors.length === 0) {
      duplicateOf = existing.get(hash) ?? (firstIndex.has(hash) ? 'batch' : null);
      if (!firstIndex.has(hash)) firstIndex.set(hash, index);
    }
    return {
      index,
      externalId: item.externalId,
      content: item.content,
      verified: item.verified,
      errors,
      warnings,
      duplicateOf,
    };
  });
  const invalid = items.filter((item) => item.errors.length > 0).length;
  const duplicates = items.filter((item) => item.duplicateOf !== null).length;
  const drafts = items.filter(
    (item) => item.errors.length === 0 && !item.duplicateOf && item.warnings.length > 0,
  ).length;
  return {
    items,
    summary: {
      total: items.length,
      ready: items.length - invalid - duplicates - drafts,
      drafts,
      invalid,
      duplicates,
    },
  };
}

/**
 * Fill the source of a question from a public resource with what the student
 * entered for the whole file (the question's own fields win). The licence
 * stays "to be confirmed" unless the student says it is clear.
 */
function withPublicSource(content: QuestionContent, details: QuestionSource): QuestionContent {
  const source: QuestionSource = { ...details, ...(content.source ?? {}) };
  if (!source.licenseStatus) source.licenseStatus = 'unclear';
  return { ...content, source };
}

/**
 * Add the valid questions of an import. `questions` are the (possibly
 * edited) preview items, each with the student's `verified` choice; invalid ones are
 * skipped and reported, duplicates are skipped. Safe to repeat. With
 * `publicSource` the file comes from a public resource (B08): its link,
 * retrieval date, version, licence and attribution go with every question,
 * whose origin is then `public_source`.
 */
export async function commitImport(
  db: StudyDb,
  ownerId: string,
  spaceId: string,
  questions: readonly unknown[],
  options: { stageId: string | null; publicSource?: QuestionSource | null },
): Promise<ImportCommitResult> {
  const { stageId, publicSource = null } = options;
  await requireQuestionSpace(db, ownerId, spaceId, { writable: true });
  if (questions.length === 0 || questions.length > QUESTION_LIMITS.importItems) {
    throw new StudyError('STUDY_IMPORT_INVALID', { reason: 'too_many_questions' });
  }
  if (stageId) await assertSpaceCourse(db, ownerId, spaceId, stageId);
  const parsed = questions.map((raw) => {
    const item = parseQuestion(raw);
    return publicSource && item.content
      ? { ...item, content: withPublicSource(item.content, publicSource) }
      : item;
  });
  const valid: Array<{ index: number; content: QuestionContent; verified: boolean }> = [];
  const outcomes: ImportCommitResult['outcomes'] = [];
  parsed.forEach((item, index) => {
    if (item.content && blockingIssues(item.issues).length === 0) {
      valid.push({ index, content: item.content, verified: item.verified });
    } else {
      outcomes.push({ index, status: 'invalid', id: null });
    }
  });
  const inserted: InsertOutcome[] = valid.length
    ? await insertQuestions(
        db,
        ownerId,
        spaceId,
        valid.map((item) => ({
          content: item.content,
          verification: verificationFor(item.content, item.verified),
          origin: publicSource ? 'public_source' : 'user_import',
          stageId,
        })),
      )
    : [];
  inserted.forEach((outcome, position) => {
    outcomes.push({ index: valid[position]!.index, status: outcome.status, id: outcome.id });
  });
  outcomes.sort((a, b) => a.index - b.index);
  return {
    created: outcomes.filter((outcome) => outcome.status === 'created').length,
    duplicates: outcomes.filter((outcome) => outcome.status === 'duplicate').length,
    invalid: outcomes.filter((outcome) => outcome.status === 'invalid').length,
    outcomes,
  };
}

function contentOrThrow(raw: unknown): QuestionContent {
  const parsed = parseQuestion(raw);
  const errors = blockingIssues(parsed.issues);
  if (!parsed.content || errors.length) {
    throw new StudyError('STUDY_QUESTION_INVALID', { issues: errors });
  }
  return parsed.content;
}

/** One question written in the editor. A repeat of an existing one is refused. */
export async function createManualQuestion(
  db: StudyDb,
  ownerId: string,
  input: { spaceId: string; question: unknown; verified: boolean; stageId: string | null },
): Promise<{ question: QuestionView; created: boolean }> {
  await requireQuestionSpace(db, ownerId, input.spaceId, { writable: true });
  if (input.stageId) await assertSpaceCourse(db, ownerId, input.spaceId, input.stageId);
  const content = contentOrThrow(input.question);
  const [outcome] = await insertQuestions(db, ownerId, input.spaceId, [
    {
      content,
      verification: verificationFor(content, input.verified),
      origin: 'manual',
      stageId: input.stageId,
    },
  ]);
  if (!outcome?.id) throw new StudyError('STUDY_QUESTION_INVALID', { reason: 'duplicate' });
  return {
    question: await getQuestion(db, ownerId, outcome.id),
    created: outcome.status === 'created',
  };
}

/**
 * Save an edit as a new version. The source (attribution, pack) is not
 * editable and carries over; an official copy keeps `official_verified` only
 * while its question content is unchanged.
 */
export async function editQuestion(
  db: StudyDb,
  ownerId: string,
  questionId: string,
  input: { question: unknown; verified: boolean; stageId: string | null; baseVersion: number },
): Promise<QuestionView> {
  const current = await getQuestion(db, ownerId, questionId);
  await requireQuestionSpace(db, ownerId, current.spaceId, { writable: true });
  const content = contentOrThrow(input.question);
  // Source and figures are not editable here (they say where the question came from).
  const withSource: QuestionContent = {
    ...content,
    source: current.source,
    ...(current.figures ? { figures: current.figures } : {}),
  };
  const sameContent = questionContentHash(withSource) === questionContentHash(current);
  const verification: VerificationState =
    input.verified && sameContent && current.verification === 'official_verified'
      ? 'official_verified'
      : verificationFor(withSource, input.verified);
  return updateQuestion(
    db,
    ownerId,
    questionId,
    { content: withSource, verification, stageId: input.stageId },
    input.baseVersion,
  );
}

/** Private copies of official pack questions (the pack itself is never changed). */
export async function copyPackQuestions(
  db: StudyDb,
  ownerId: string,
  input: { spaceId: string; packId: string; questionIds: readonly string[] },
): Promise<{ created: number; duplicates: number; ids: string[] }> {
  const pack = findPack(input.packId);
  if (!pack) throw new StudyError('STUDY_PACK_NOT_FOUND');
  await requireQuestionSpace(db, ownerId, input.spaceId, { writable: true });
  const wanted = new Set(input.questionIds);
  const questions = pack.questions.filter((question) => wanted.has(question.id));
  if (questions.length !== wanted.size || questions.length === 0) {
    throw new StudyError('STUDY_QUESTION_NOT_FOUND');
  }
  const outcomes = await insertQuestions(
    db,
    ownerId,
    input.spaceId,
    questions.map((question) => ({
      content: packQuestionContent(pack, question),
      verification: 'official_verified',
      origin: 'official',
      fingerprint: packFingerprint(pack.id, pack.version, question.id),
    })),
  );
  return {
    created: outcomes.filter((outcome) => outcome.status === 'created').length,
    duplicates: outcomes.filter((outcome) => outcome.status === 'duplicate').length,
    ids: outcomes.flatMap((outcome) => (outcome.id ? [outcome.id] : [])),
  };
}
