/**
 * Rule-built papers and objective attempts (learning plan B07). No model
 * calls anywhere on this path.
 *
 * Preview and publish run the same deterministic selection: the preview
 * returns its seed, and publishing with that seed over an unchanged bank
 * freezes exactly the paper that was shown. A shortfall (too few questions of
 * a type, or a chosen knowledge point with none) is reported, never padded.
 */
import { createHash, randomBytes } from 'node:crypto';

import type { Queryable } from '@openmaic/storage/document/pg';

import { createLogger } from '@/lib/logger';
import { projectExamAttempt } from '@/lib/server/study/memory/projector';
import { StudyError, type StudyDb } from '@/lib/server/study/spaces/repository';
import {
  assertSpaceCourse,
  conceptKeysOf,
  loadBankCandidates,
  loadQuestionVersions,
  questionContentHash,
  requireQuestionSpace,
} from '@/lib/server/study/questions/repository';
import {
  ATTEMPT_LIMITS,
  answersByteLength,
  canonicalAnswers,
  gradeAttempt,
  parseAnswers,
  type AttemptAnswers,
  type AttemptView,
  type PaperItemSource,
} from '@/lib/study/assessments/contracts';
import {
  selectQuestions,
  type BlueprintCandidate,
  type BlueprintResult,
  type ExamBlueprint,
  type PaperPreview,
} from '@/lib/study/questions/blueprint';
import {
  conceptKey,
  effectiveRubric,
  packFingerprint,
  type QuestionContent,
  type QuestionOrigin,
  type VerificationState,
} from '@/lib/study/questions/contracts';
import { findPack, packQuestionContent } from '@/lib/study/questions/packs';

import {
  attemptPaperId,
  createPaperId,
  findPaperByKey,
  getAttemptView,
  insertPaper,
  paperItemViews,
  saveDraftAnswers,
  seenInSpace,
  submitAttempt,
  type FrozenItem,
} from './repository';

const log = createLogger('StudyExams');

export type BlueprintInput = Omit<ExamBlueprint, 'seed'> & { seed: string | null };

interface Resolved {
  content: QuestionContent;
  origin: QuestionOrigin;
  verification: VerificationState;
  contentHash: string;
  questionId: string | null;
  questionVersion: number | null;
  packQuestion: string | null;
  packTitle: string | null;
}

function drawSeed(): string {
  return randomBytes(9).toString('base64url');
}

/**
 * Candidates from the bank (gradable current versions) and the enabled packs.
 * A pack question the student already copied, or with the same content as a
 * bank question, is left to the bank copy, so a paper never asks it twice.
 */
async function candidates(
  db: Queryable,
  ownerId: string,
  blueprint: BlueprintInput,
): Promise<{ list: BlueprintCandidate[]; resolve: (ref: string) => Resolved | 'bank' }> {
  const bank = await loadBankCandidates(db, ownerId, blueprint.spaceId);
  const seen = await seenInSpace(db, ownerId, blueprint.spaceId);
  const list: BlueprintCandidate[] = [];
  const bankHashes = new Set<string>();
  const bankFingerprints = new Set<string>();
  for (const row of bank) {
    if (bankHashes.has(row.contentHash)) continue;
    bankHashes.add(row.contentHash);
    bankFingerprints.add(row.fingerprint);
    list.push({
      ref: `bank:${row.id}@${row.version}`,
      tier: row.origin === 'public_source' ? 'public' : 'bank',
      type: row.type,
      conceptKeys: row.conceptKeys,
      stageId: row.stageId,
      difficulty: row.difficulty,
      verified: row.verification !== 'unverified',
      seen: seen.questionIds.has(row.id) || seen.hashes.has(row.contentHash),
    });
  }
  const packs = new Map<string, Resolved>();
  for (const packId of blueprint.packIds) {
    const pack = findPack(packId);
    if (!pack) throw new StudyError('STUDY_PACK_NOT_FOUND');
    for (const question of pack.questions) {
      const ref = packFingerprint(pack.id, pack.version, question.id);
      const content = packQuestionContent(pack, question);
      const hash = questionContentHash(content);
      if (bankHashes.has(hash) || bankFingerprints.has(ref)) continue;
      packs.set(ref, {
        content,
        origin: 'official',
        verification: 'official_verified',
        contentHash: hash,
        questionId: null,
        questionVersion: null,
        packQuestion: ref,
        packTitle: pack.title,
      });
      list.push({
        ref,
        tier: 'pack',
        type: content.type,
        conceptKeys: content.concepts.map(conceptKey),
        stageId: null,
        difficulty: content.difficulty,
        verified: true,
        seen: seen.packQuestions.has(ref) || seen.hashes.has(hash),
      });
    }
  }
  return { list, resolve: (ref) => packs.get(ref) ?? 'bank' };
}

async function select(
  db: Queryable,
  ownerId: string,
  input: BlueprintInput,
  options: { writable: boolean },
): Promise<{
  blueprint: ExamBlueprint;
  result: BlueprintResult;
  picked: Resolved[];
  uncoveredConceptIds: string[];
}> {
  await requireQuestionSpace(db, ownerId, input.spaceId, options);
  if (input.stageId) await assertSpaceCourse(db, ownerId, input.spaceId, input.stageId);
  const keys = await conceptKeysOf(db, ownerId, input.spaceId, input.conceptIds);
  if (keys.size !== input.conceptIds.length) {
    throw new StudyError('STUDY_QUESTION_INVALID', { field: 'conceptIds' });
  }
  const blueprint: ExamBlueprint = { ...input, seed: input.seed ?? drawSeed() };
  const conceptKeys = input.conceptIds.map((id) => keys.get(id)!);
  const { list, resolve } = await candidates(db, ownerId, blueprint);
  const result = selectQuestions(blueprint, list, conceptKeys);
  const bankRefs = result.picked
    .filter((candidate) => candidate.tier !== 'pack')
    .map((candidate) => {
      const [id, version] = candidate.ref.slice('bank:'.length).split('@');
      return { id: id!, version: Number(version) };
    });
  const versions = await loadQuestionVersions(db, ownerId, bankRefs);
  const picked = result.picked.map((candidate): Resolved => {
    const pack = resolve(candidate.ref);
    if (pack !== 'bank') return pack;
    const frozen = versions.get(candidate.ref.slice('bank:'.length));
    if (!frozen) throw new StudyError('STUDY_REVISION_CONFLICT');
    return {
      content: frozen.content,
      origin: frozen.origin,
      verification: frozen.verification,
      contentHash: frozen.contentHash,
      questionId: frozen.id,
      questionVersion: frozen.version,
      packQuestion: null,
      packTitle: null,
    };
  });
  const keyToId = new Map([...keys.entries()].map(([id, key]) => [key, id]));
  return {
    blueprint,
    result,
    picked,
    uncoveredConceptIds: result.uncoveredConcepts.map((key) => keyToId.get(key)!),
  };
}

export async function previewPaper(
  db: Queryable,
  ownerId: string,
  input: BlueprintInput,
): Promise<PaperPreview> {
  const { blueprint, result, picked, uncoveredConceptIds } = await select(db, ownerId, input, {
    writable: false,
  });
  return {
    seed: blueprint.seed,
    items: picked.map((item, index) => ({
      ref: result.picked[index]!.ref,
      tier: result.picked[index]!.tier,
      type: item.content.type,
      ...(item.content.subtype ? { subtype: item.content.subtype } : {}),
      stem: item.content.stem,
      concepts: item.content.concepts,
      difficulty: item.content.difficulty,
      points: item.content.points,
      origin: item.origin,
      verification: item.verification,
    })),
    totalPoints: picked.reduce((sum, item) => sum + item.content.points, 0),
    shortfalls: result.shortfalls,
    uncoveredConceptIds,
    available: result.available,
    complete: result.shortfalls.length === 0 && uncoveredConceptIds.length === 0,
  };
}

function frozenItem(item: Resolved): FrozenItem {
  const source = item.content.source;
  const itemSource: PaperItemSource = {
    origin: item.origin,
    verification: item.verification,
    ...(source?.title ? { title: source.title } : {}),
    ...(source?.page ? { page: source.page } : {}),
    ...(source?.url ? { url: source.url } : {}),
    ...(source?.license ? { license: source.license } : {}),
    ...(source?.attribution ? { attribution: source.attribution } : {}),
    ...(item.packTitle ? { packTitle: item.packTitle } : {}),
    ...(source?.licenseStatus ? { licenseStatus: source.licenseStatus } : {}),
    ...(source?.answerBasis ? { answerBasis: source.answerBasis } : {}),
    ...(source?.material ? { material: source.material } : {}),
  };
  return {
    questionId: item.questionId,
    questionVersion: item.questionVersion,
    packQuestion: item.packQuestion,
    contentHash: item.contentHash,
    snapshot: {
      type: item.content.type,
      ...(item.content.type === 'short_answer' ? { subtype: item.content.subtype ?? 'short' } : {}),
      stem: item.content.stem,
      options: item.content.options,
      points: item.content.points,
      concepts: item.content.concepts,
      difficulty: item.content.difficulty,
      source: itemSource,
      ...(item.content.figures?.length ? { figures: item.content.figures } : {}),
    },
    key: {
      answer: item.content.answer,
      explanation: item.content.explanation,
      // Open items freeze their guide with the scoring points made explicit.
      guide:
        item.content.type === 'short_answer'
          ? {
              referenceAnswer: item.content.guide?.referenceAnswer ?? null,
              finalAnswer: item.content.guide?.finalAnswer ?? null,
              rubric: effectiveRubric(item.content),
            }
          : null,
    },
  };
}

/**
 * Freeze a paper. Retrying with the same idempotency key returns the same
 * paper; reusing the key for a different request is a conflict.
 */
export async function publishPaper(
  db: StudyDb,
  ownerId: string,
  input: { blueprint: BlueprintInput; title: string; idempotencyKey: string },
): Promise<{ paperId: string; created: boolean }> {
  const requestHash = createHash('sha256')
    .update(JSON.stringify([input.blueprint, input.title]))
    .digest('hex');
  const replay = async () => {
    const existing = await findPaperByKey(db, ownerId, input.idempotencyKey);
    if (!existing) return null;
    if (existing.requestHash !== requestHash) throw new StudyError('STUDY_IDEMPOTENCY_CONFLICT');
    return { paperId: existing.id, created: false };
  };
  const earlier = await replay();
  if (earlier) return earlier;
  const outcome = await db.withTransaction(async (tx) => {
    const { blueprint, result, picked, uncoveredConceptIds } = await select(
      tx,
      ownerId,
      input.blueprint,
      { writable: true },
    );
    if (result.shortfalls.length || uncoveredConceptIds.length || picked.length === 0) {
      throw new StudyError('STUDY_EXAM_INSUFFICIENT', {
        shortfalls: result.shortfalls,
        uncoveredConceptIds,
      });
    }
    const paperId = createPaperId();
    const inserted = await insertPaper(tx, ownerId, {
      id: paperId,
      spaceId: blueprint.spaceId,
      title: input.title,
      blueprint,
      items: picked.map(frozenItem),
      idempotencyKey: input.idempotencyKey,
      requestHash,
    });
    return inserted ? { paperId, created: true } : null;
  });
  if (outcome) return outcome;
  // Another request with the same key published first.
  const raced = await replay();
  if (!raced) throw new StudyError('STUDY_IDEMPOTENCY_CONFLICT');
  return raced;
}

/** Save a draft after checking it against the paper; null when the answers are malformed. */
export async function saveAttemptDraft(
  db: StudyDb,
  ownerId: string,
  attemptId: string,
  raw: unknown,
  baseRevision: number,
): Promise<{ revision: number; updatedAt: string } | null> {
  const paperId = await attemptPaperId(db, ownerId, attemptId);
  const answers = parseAnswers(raw, await paperItemViews(db, ownerId, paperId));
  if (!answers || answersByteLength(answers) > ATTEMPT_LIMITS.answersBytes) return null;
  return saveDraftAnswers(db, ownerId, attemptId, answers, baseRevision);
}

/** Grade and freeze an attempt, then record the learning event (best effort). */
export async function submitPaperAttempt(
  db: StudyDb,
  ownerId: string,
  attemptId: string,
  input: { answers: AttemptAnswers | null; baseRevision: number | null; submitKey: string },
): Promise<{ attempt: AttemptView; alreadySubmitted: boolean }> {
  const outcome = await submitAttempt(db, ownerId, attemptId, input, (items, answers) => {
    const valid = parseAnswers(answers, items);
    if (!valid || answersByteLength(valid) > ATTEMPT_LIMITS.answersBytes) return null;
    const grading = gradeAttempt(
      items.map((item) => ({ ...item, key: item.answer })),
      valid,
    );
    const digest = createHash('sha256').update(canonicalAnswers(valid)).digest('hex');
    return { answers: valid, grading, digest };
  });
  if (outcome.kind === 'submitted') {
    await projectExamAttempt(db, ownerId, attemptId);
  } else {
    log.info('attempt already submitted', { sameKey: outcome.sameKey });
  }
  return {
    attempt: await getAttemptView(db, ownerId, attemptId),
    alreadySubmitted: outcome.kind === 'already',
  };
}
