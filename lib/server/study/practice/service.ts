/**
 * AI practice jobs (learning plan B11). Runs in web, one batch per request,
 * driven by the page (like B09 grading): the page creates a job after the
 * student confirmed its plan, then asks for the next step until the job is
 * no longer pending.
 *
 * - Planning calls no model. A bank paper never reaches this module; a mixed
 *   paper plans only its shortfalls (the deterministic bank picks stay as
 *   previewed), an AI paper plans every section, a variant job writes
 *   1–3 questions like one wrong question.
 * - A job is created only with the student's consent and an idempotency
 *   key; its evidence (material passages of fixed versions, the original
 *   question for variants) and call cap are frozen with it.
 * - One step = one batch (≤ 5 questions): generation, at most one repair of
 *   non-JSON output, program checks, one review call. Only what the review
 *   passes is added to the bank (origin `ai_generated`, unverified), in the
 *   same transaction as the job update, by the step that still holds the
 *   lease — a cancelled job or a lost lease stores nothing.
 * - The job never makes more calls than its cap. When the cap is reached
 *   (or the model fails) it stops with what it has; the student chooses to
 *   publish fewer, continue (new allowance, at most twice) or cancel.
 */
import { createHash, randomUUID } from 'node:crypto';

import {
  GatewayError,
  ModelSelectionError,
  gateway,
  resolveRequestBinding,
  userText,
  type ModelBinding,
  type ModelGateway,
} from '@/lib/model-gateway';
import { createLogger } from '@/lib/logger';
import { runIndependentHeavyTaskRequest } from '@/lib/server/heavy-task-admission/independent-request';
import {
  previewPaper,
  publishJobPaper,
  type BlueprintInput,
} from '@/lib/server/study/exams/service';
import {
  insertQuestionsTx,
  listConcepts,
  questionContentHash,
  requireQuestionSpace,
} from '@/lib/server/study/questions/repository';
import { StudyError, type StudyDb } from '@/lib/server/study/spaces/repository';
import { findItemSpace, readOccurrences } from '@/lib/server/study/wrongbook/repository';
import { isWrong } from '@/lib/study/wrongbook/contracts';
import {
  PRACTICE_LIMITS,
  callCapFor,
  nextBatch,
  remainingTargets,
  type GenerationPlan,
  type GenerationTarget,
  type PaperJobRequest,
  type PracticeEvidence,
  type PracticeJobView,
  type PracticeMode,
  type RejectedQuestion,
  type VariantJobRequest,
} from '@/lib/study/practice/contracts';
import {
  REPAIR_SUFFIX,
  REVIEW_SYSTEM_PROMPT,
  buildGenerationMessage,
  buildReviewMessage,
  checkGeneration,
  generationSystemPrompt,
  parseReview,
  type CandidateQuestion,
  type DuplicateIndex,
} from '@/lib/study/practice/generation';
import type { PaperPreview } from '@/lib/study/questions/blueprint';
import {
  conceptKey,
  type GenerationSourceRef,
  type QuestionContent,
  type QuestionSource,
} from '@/lib/study/questions/contracts';
import type { Queryable } from '@openmaic/storage/document/pg';

import {
  materialsOf,
  narrowScope,
  paperEvidence,
  practiceScope,
  retrievalSignature,
  variantEvidence,
} from './evidence';
import {
  claimPracticeStep,
  createPracticeJobId,
  findPracticeJobByKey,
  finishPracticeStep,
  getPracticeJob,
  insertPracticeJob,
  lockClaimedJob,
  recentPracticeJobs,
  setPracticeStatus,
  type PracticeJobRow,
} from './repository';

const log = createLogger('StudyPractice');

/** Generation may take this long per call; review less (one batch must fit in the step lease). */
const GENERATION_TIMEOUT_MS = 100_000;
const REVIEW_TIMEOUT_MS = 70_000;

export interface PracticeDependencies {
  gateway?: Pick<ModelGateway, 'complete'>;
}

function hashOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function courseTitle(db: Queryable, stageId: string | null): Promise<string | null> {
  if (!stageId) return null;
  const result = await db.query<{ name: string | null }>(
    'SELECT name FROM document_stages WHERE id = $1',
    [stageId],
  );
  return result.rows[0]?.name?.trim() || null;
}

// ── planning (no model calls) ───────────────────────────────────────────────

interface PaperPlan {
  plan: GenerationPlan;
  preview: PaperPreview;
  /** Chosen knowledge points the bank picks do not cover. */
  uncovered: string[];
}

async function planPaper(
  db: StudyDb,
  ownerId: string,
  input: BlueprintInput,
  mode: PracticeMode,
): Promise<PaperPlan> {
  const preview = await previewPaper(db, ownerId, input);
  const concepts = await listConcepts(db, ownerId, input.spaceId);
  const names = new Map(concepts.map((concept) => [concept.id, concept.name]));
  const chosen = input.conceptIds.map((id) => names.get(id)!).filter(Boolean);
  const uncoveredNames = preview.uncoveredConceptIds.map((id) => names.get(id)!).filter(Boolean);
  const targets: GenerationTarget[] =
    mode === 'ai'
      ? input.sections.map((section) => ({ type: section.type, count: section.count }))
      : preview.shortfalls.map((shortfall) => ({
          type: shortfall.type,
          count: shortfall.wanted - shortfall.available,
        }));
  const total = targets.reduce((sum, target) => sum + target.count, 0);
  // Uncovered points first, so the new questions fill them before the rest.
  const ordered = [...uncoveredNames, ...chosen.filter((name) => !uncoveredNames.includes(name))];
  const signature = await retrievalSignature(db);
  const scope = await practiceScope(db, ownerId, input.spaceId, signature);
  const plan: GenerationPlan = {
    mode,
    targets,
    total,
    concepts: ordered,
    materials: materialsOf(scope).slice(0, PRACTICE_LIMITS.materialVersions),
    maxCalls: callCapFor(total),
    blocked:
      total === 0
        ? 'nothing_to_generate'
        : total > PRACTICE_LIMITS.maxQuestions
          ? 'too_many'
          : !signature
            ? 'retrieval_unavailable'
            : scope.length === 0
              ? 'no_materials'
              : null,
  };
  return {
    plan,
    preview: mode === 'ai' ? { ...preview, items: [], totalPoints: 0, complete: false } : preview,
    uncovered: mode === 'ai' ? chosen : uncoveredNames,
  };
}

/** The paper preview with the generation plan of a mixed or AI paper. */
export async function previewPracticePaper(
  db: StudyDb,
  ownerId: string,
  input: BlueprintInput,
  mode: PracticeMode,
): Promise<PaperPreview & { generation: GenerationPlan }> {
  const { plan, preview } = await planPaper(db, ownerId, input, mode);
  return { ...preview, generation: plan };
}

// ── creating jobs ───────────────────────────────────────────────────────────

async function admitJob(
  db: StudyDb,
  ownerId: string,
  idempotencyKey: string,
  requestHash: string,
): Promise<PracticeJobRow | null> {
  const existing = await findPracticeJobByKey(db, ownerId, idempotencyKey);
  if (existing) {
    if (existing.requestHash !== requestHash) throw new StudyError('STUDY_IDEMPOTENCY_CONFLICT');
    return existing;
  }
  if ((await recentPracticeJobs(db, ownerId)) >= PRACTICE_LIMITS.jobsPerDay) {
    throw new StudyError('STUDY_PRACTICE_LIMIT');
  }
  return null;
}

async function storeJob(
  db: StudyDb,
  ownerId: string,
  input: {
    spaceId: string;
    request: PaperJobRequest | VariantJobRequest;
    evidence: PracticeEvidence[];
    requestHash: string;
    idempotencyKey: string;
    total: number;
  },
): Promise<PracticeJobRow> {
  const id = createPracticeJobId();
  const inserted = await insertPracticeJob(db, ownerId, {
    id,
    spaceId: input.spaceId,
    kind: input.request.kind,
    request: input.request,
    evidence: input.evidence,
    requestHash: input.requestHash,
    idempotencyKey: input.idempotencyKey,
    callCap: callCapFor(input.total),
  });
  if (inserted) return getPracticeJob(db, ownerId, id);
  const raced = await findPracticeJobByKey(db, ownerId, input.idempotencyKey);
  if (!raced || raced.requestHash !== input.requestHash) {
    throw new StudyError('STUDY_IDEMPOTENCY_CONFLICT');
  }
  return raced;
}

/**
 * A job for the gap of a mixed paper or a whole AI paper. The plan is
 * computed again here from the blueprint (never taken from the client).
 */
export async function createPaperJob(
  db: StudyDb,
  ownerId: string,
  input: {
    blueprint: BlueprintInput & { seed: string };
    mode: PracticeMode;
    materialVersionIds: string[] | null;
    consent: boolean;
    idempotencyKey: string;
  },
): Promise<PracticeJobView> {
  if (!input.consent) throw new StudyError('STUDY_PRACTICE_CONSENT_REQUIRED');
  const requestHash = hashOf(['paper', input.blueprint, input.mode, input.materialVersionIds]);
  const earlier = await admitJob(db, ownerId, input.idempotencyKey, requestHash);
  if (earlier) return jobView(earlier);
  const space = await requireQuestionSpace(db, ownerId, input.blueprint.spaceId, {
    writable: true,
  });
  const { plan, preview, uncovered } = await planPaper(db, ownerId, input.blueprint, input.mode);
  if (plan.blocked === 'nothing_to_generate') {
    throw new StudyError('STUDY_PRACTICE_NOTHING_TO_GENERATE');
  }
  if (plan.blocked === 'too_many') {
    throw new StudyError('STUDY_PRACTICE_INVALID', { field: 'sections' });
  }
  if (plan.blocked) throw new StudyError('STUDY_PRACTICE_NO_EVIDENCE', { reason: plan.blocked });
  const signature = await retrievalSignature(db);
  const scope = narrowScope(
    await practiceScope(db, ownerId, input.blueprint.spaceId, signature),
    input.materialVersionIds,
  );
  const course = await courseTitle(db, input.blueprint.stageId);
  const evidence = await db.withTransaction((tx) =>
    paperEvidence(
      tx,
      ownerId,
      scope,
      [...plan.concepts, course ?? '', plan.concepts.length ? '' : space.name].join(' '),
    ),
  );
  if (evidence.length === 0)
    throw new StudyError('STUDY_PRACTICE_NO_EVIDENCE', { reason: 'empty' });
  const request: PaperJobRequest = {
    kind: 'paper',
    mode: input.mode,
    blueprint: { ...input.blueprint, seed: preview.seed },
    bankRefs: input.mode === 'mixed' ? preview.items.map((item) => item.ref) : [],
    targets: plan.targets,
    concepts: plan.concepts,
    uncovered,
    materials: materialsOf(scope),
    courseTitle: course,
    spaceName: space.name,
  };
  const job = await storeJob(db, ownerId, {
    spaceId: input.blueprint.spaceId,
    request,
    evidence,
    requestHash,
    idempotencyKey: input.idempotencyKey,
    total: plan.total,
  });
  log.info('practice job created', { kind: 'paper', mode: input.mode, total: plan.total });
  return jobView(job);
}

/** A job for 1–3 variants of one wrong question (its newest wrong answer as asked). */
export async function createVariantJob(
  db: StudyDb,
  ownerId: string,
  input: {
    wrongItemId: string;
    count: number;
    consent: boolean;
    idempotencyKey: string;
  },
): Promise<PracticeJobView> {
  if (!input.consent) throw new StudyError('STUDY_PRACTICE_CONSENT_REQUIRED');
  if (
    !Number.isInteger(input.count) ||
    input.count < 1 ||
    input.count > PRACTICE_LIMITS.variantMax
  ) {
    throw new StudyError('STUDY_PRACTICE_INVALID', { field: 'count' });
  }
  const requestHash = hashOf(['variant', input.wrongItemId, input.count]);
  const earlier = await admitJob(db, ownerId, input.idempotencyKey, requestHash);
  if (earlier) return jobView(earlier);
  const item = await findItemSpace(db, ownerId, input.wrongItemId);
  const space = await requireQuestionSpace(db, ownerId, item.spaceId, { writable: true });
  const occurrences = await readOccurrences(db, ownerId, input.wrongItemId);
  // The question as last asked wrongly — the original, not an earlier variant of it.
  const wrong =
    occurrences.find(
      (occurrence) =>
        isWrong(occurrence.outcome) && !occurrence.question.source?.generation?.family,
    ) ?? occurrences.find((occurrence) => isWrong(occurrence.outcome));
  if (!wrong) throw new StudyError('STUDY_WRONG_ITEM_NOT_FOUND');
  const question = wrong.question;
  const signature = await retrievalSignature(db);
  const scope = await practiceScope(db, ownerId, item.spaceId, signature);
  const evidence = await db.withTransaction((tx) =>
    variantEvidence(tx, ownerId, scope.slice(0, PRACTICE_LIMITS.materialVersions), question),
  );
  const original: QuestionContent = {
    type: question.type,
    ...(question.type === 'short_answer' ? { subtype: question.subtype ?? 'short' } : {}),
    stem: question.stem,
    options: question.options,
    answer: question.type === 'short_answer' ? [] : question.answer,
    ...(question.type === 'short_answer'
      ? {
          guide: {
            referenceAnswer: question.reference ?? null,
            finalAnswer: question.finalAnswer ?? null,
            rubric: [],
          },
        }
      : {}),
    explanation: question.explanation ?? null,
    concepts: question.concepts,
    difficulty: null,
    points: 1,
    source: null,
  };
  const request: VariantJobRequest = {
    kind: 'variant',
    wrongItemId: input.wrongItemId,
    questionKey: item.questionKey,
    targets: [{ type: question.type, count: input.count }],
    subtype: question.type === 'short_answer' ? (question.subtype ?? 'short') : null,
    concepts: question.concepts.slice(0, 8),
    materials: materialsOf(scope.slice(0, PRACTICE_LIMITS.materialVersions)),
    spaceName: space.name,
    original: { hash: questionContentHash(original), stem: question.stem },
  };
  const job = await storeJob(db, ownerId, {
    spaceId: item.spaceId,
    request,
    evidence,
    requestHash,
    idempotencyKey: input.idempotencyKey,
    total: input.count,
  });
  log.info('practice job created', { kind: 'variant', total: input.count });
  return jobView(job);
}

// ── views ───────────────────────────────────────────────────────────────────

export function jobView(row: PracticeJobRow, now = Date.now()): PracticeJobView {
  const request = row.request;
  const total = request.targets.reduce((sum, target) => sum + target.count, 0);
  const covered = new Set(row.produced.flatMap((question) => question.concepts.map(conceptKey)));
  const wanted = request.kind === 'paper' ? request.uncovered : [];
  const budgetLeft = row.calls + 2 <= row.callCap;
  return {
    id: row.id,
    spaceId: row.spaceId,
    kind: row.kind,
    mode: request.kind === 'paper' ? request.mode : null,
    status: row.status,
    targets: request.targets,
    total,
    produced: row.produced,
    rejected: row.rejected,
    rejectedCount: row.rejected.length,
    concepts: request.concepts,
    uncoveredConcepts: wanted.filter((name) => !covered.has(conceptKey(name))),
    materials: request.materials,
    evidence: row.evidence.map((piece) => ({
      id: piece.id,
      kind: piece.kind,
      ...(piece.materialId ? { materialId: piece.materialId } : {}),
      ...(piece.versionId ? { versionId: piece.versionId } : {}),
      ...(piece.page !== undefined ? { page: piece.page } : {}),
      ...(piece.title ? { title: piece.title } : {}),
    })),
    calls: row.calls,
    callCap: row.callCap,
    continues: row.continues,
    canContinue:
      row.status === 'stopped' &&
      row.paperId === null &&
      remainingTargets(request.targets, row.produced).length > 0 &&
      (budgetLeft || row.continues < PRACTICE_LIMITS.continues),
    lastError: row.lastError,
    running:
      row.status === 'pending' && row.leaseUntil !== null && Date.parse(row.leaseUntil) > now,
    paperId: row.paperId,
    wrongItemId: request.kind === 'variant' ? request.wrongItemId : null,
    bankCount: request.kind === 'paper' ? request.bankRefs.length : 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getPracticeJobView(
  db: Queryable,
  ownerId: string,
  jobId: string,
): Promise<PracticeJobView> {
  return jobView(await getPracticeJob(db, ownerId, jobId));
}

// ── stop, continue ──────────────────────────────────────────────────────────

/** Cancel an unpublished job. Questions it already added stay in the bank (unverified). */
export async function cancelPracticeJob(
  db: StudyDb,
  ownerId: string,
  jobId: string,
): Promise<PracticeJobView> {
  const job = await getPracticeJob(db, ownerId, jobId);
  if (job.status === 'cancelled') return jobView(job);
  const updated = await setPracticeStatus(
    db,
    ownerId,
    jobId,
    ['pending', 'stopped', 'completed'],
    'cancelled',
  );
  if (!updated) throw new StudyError('STUDY_PRACTICE_JOB_STATE', { status: job.status });
  return jobView(updated);
}

/**
 * Continue a stopped job: with allowance left (it stopped on a model error)
 * it simply resumes; at its cap it gets the allowance of what is left —
 * at most PRACTICE_LIMITS.continues times.
 */
export async function continuePracticeJob(
  db: StudyDb,
  ownerId: string,
  jobId: string,
): Promise<PracticeJobView> {
  const job = await getPracticeJob(db, ownerId, jobId);
  const left = remainingTargets(job.request.targets, job.produced);
  if (job.status !== 'stopped' || job.paperId || left.length === 0) {
    throw new StudyError('STUDY_PRACTICE_JOB_STATE', { status: job.status });
  }
  const atCap = job.calls + 2 > job.callCap;
  if (atCap && job.continues >= PRACTICE_LIMITS.continues) {
    throw new StudyError('STUDY_PRACTICE_LIMIT', { reason: 'continues' });
  }
  const extra = callCapFor(left.reduce((sum, target) => sum + target.count, 0));
  const updated = await setPracticeStatus(
    db,
    ownerId,
    jobId,
    ['stopped'],
    'pending',
    atCap
      ? {
          callCap: Math.min(60, job.callCap + extra),
          continues: job.continues + 1,
          lastError: null,
        }
      : { lastError: null },
  );
  if (!updated) throw new StudyError('STUDY_PRACTICE_JOB_STATE', { status: job.status });
  return jobView(updated);
}

/** Freeze the job's paper (see publishJobPaper); the default title names what it is. */
export async function publishPracticeJob(
  db: StudyDb,
  ownerId: string,
  jobId: string,
  input: { title: string | null; idempotencyKey: string; acceptShort: boolean },
): Promise<{ paperId: string; created: boolean }> {
  const job = await getPracticeJob(db, ownerId, jobId);
  const title = (
    input.title?.trim() ||
    (job.request.kind === 'variant'
      ? job.request.concepts[0]
        ? `变式练习 · ${job.request.concepts[0]}`
        : '变式练习'
      : `${job.request.spaceName} · AI 练习`)
  ).slice(0, 80);
  return publishJobPaper(db, ownerId, jobId, {
    title,
    idempotencyKey: input.idempotencyKey,
    acceptShort: input.acceptShort,
  });
}

// ── steps ───────────────────────────────────────────────────────────────────

async function bindingFor(req: Request, body: unknown): Promise<ModelBinding> {
  try {
    const binding = await resolveRequestBinding(req, body, 'study-practice');
    if (!binding.credentialReady) {
      throw new StudyError('STUDY_PRACTICE_MODEL_UNAVAILABLE', { reason: 'credential' });
    }
    return binding;
  } catch (error) {
    if (error instanceof ModelSelectionError || error instanceof GatewayError) {
      throw new StudyError('STUDY_PRACTICE_MODEL_UNAVAILABLE', { reason: error.code });
    }
    throw error;
  }
}

/** The model that actually answers (a platform default names its alias). */
function modelName(binding: ModelBinding): string {
  return binding.source === 'platform' && binding.providerId && binding.modelId
    ? `${binding.providerId}:${binding.modelId}`
    : binding.modelString;
}

async function duplicateIndex(
  db: Queryable,
  ownerId: string,
  job: PracticeJobRow,
): Promise<DuplicateIndex> {
  const hashes = await db.query<{ content_hash: string; source_fingerprint: string }>(
    `SELECT v.content_hash, q.source_fingerprint
       FROM study_questions q
       JOIN study_question_versions v
         ON v.owner_id = q.owner_id AND v.question_id = q.id AND v.version = q.current_version
      WHERE q.owner_id = $1 AND q.space_id = $2`,
    [ownerId, job.spaceId],
  );
  const stems = await db.query<{ id: string; stem: string }>(
    `SELECT q.id, v.stem
       FROM study_questions q
       JOIN study_question_versions v
         ON v.owner_id = q.owner_id AND v.question_id = q.id AND v.version = q.current_version
      WHERE q.owner_id = $1 AND q.space_id = $2
      ORDER BY q.updated_at DESC
      LIMIT 300`,
    [ownerId, job.spaceId],
  );
  const set = new Set<string>();
  for (const row of hashes.rows) {
    set.add(row.content_hash);
    set.add(row.source_fingerprint);
  }
  return {
    hashes: set,
    stems: stems.rows.map((row) => ({ questionId: row.id, stem: row.stem })),
    original: job.request.kind === 'variant' ? job.request.original : null,
  };
}

function generationSource(
  job: PracticeJobRow,
  candidate: CandidateQuestion,
  model: string,
): QuestionSource {
  const byId = new Map(job.evidence.map((piece) => [piece.id, piece]));
  const refs: GenerationSourceRef['refs'] = [];
  for (const ref of candidate.refs) {
    const piece = byId.get(ref);
    if (piece?.kind !== 'material' || !piece.materialId || !piece.versionId || !piece.artifactId) {
      continue;
    }
    if (
      refs.some(
        (existing) =>
          existing.versionId === piece.versionId && existing.page === (piece.page ?? null),
      )
    ) {
      continue;
    }
    refs.push({
      materialId: piece.materialId,
      versionId: piece.versionId,
      versionNo: piece.versionNo ?? 0,
      artifactId: piece.artifactId,
      page: piece.page ?? null,
      ...(piece.title ? { title: piece.title.slice(0, 40) } : {}),
    });
    if (refs.length === 3) break;
  }
  const generation: GenerationSourceRef = {
    jobId: job.id,
    model: model.slice(0, 120),
    review: 'ai_reviewed',
    refs,
    ...(job.request.kind === 'variant'
      ? {
          family: {
            questionKey: job.request.questionKey,
            wrongItemId: job.request.wrongItemId,
          },
        }
      : {}),
  };
  const source: QuestionSource = { title: 'AI 出题', generation };
  // The source column holds at most 2000 bytes: drop material titles first.
  if (JSON.stringify(source).length > 1800) {
    generation.refs = refs.map(({ title: _title, ...ref }) => ref);
  }
  return source;
}

interface StepUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  known: boolean;
}

type ReviewedCandidate = CandidateQuestion & { review: string };

type StepOutcome = {
  accepted: ReviewedCandidate[];
  rejected: RejectedQuestion[];
  error: string | null;
  model: string;
};

async function runBatch(
  req: Request,
  db: StudyDb,
  ownerId: string,
  job: PracticeJobRow,
  batch: GenerationTarget[],
  binding: ModelBinding,
  signal: AbortSignal,
  usage: StepUsage,
  deps: PracticeDependencies,
): Promise<StepOutcome> {
  const request = job.request;
  const batchNo = job.steps;
  const model = modelName(binding);
  const variant = request.kind === 'variant';
  const duplicates = await duplicateIndex(db, ownerId, job);
  const requestId = randomUUID();
  const budget = () => job.calls + usage.calls < job.callCap;
  const call = async (
    system: string,
    message: string,
    maxOutputTokens: number,
    timeoutMs: number,
  ) => {
    usage.calls += 1;
    const result = await (deps.gateway ?? gateway).complete(
      binding,
      {
        system,
        messages: [userText(message)],
        maxOutputTokens,
        temperature: variant ? 0.7 : 0.5,
      },
      {
        source: 'study-practice',
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        ownerId,
        retry: 'none',
        usage: { requestId, eventKey: `practice:${job.id}:${batchNo}:${usage.calls}` },
      },
    );
    usage.inputTokens += result.usage.inputTokens;
    usage.outputTokens += result.usage.outputTokens;
    if (result.usage.inputTokens === 0 && result.usage.outputTokens === 0) usage.known = false;
    return result.text;
  };
  const failure = (error: unknown): string => {
    usage.known = false;
    if (req.signal.aborted) return 'interrupted';
    if (signal.aborted) return 'lease_lost';
    if (error instanceof GatewayError) {
      return error.code === 'MODEL_ABORTED' || error.code === 'MODEL_TIMEOUT'
        ? 'timeout'
        : 'model_error';
    }
    if ((error as Error)?.name === 'TimeoutError' || (error as Error)?.name === 'AbortError') {
      return 'timeout';
    }
    throw error;
  };
  const rejected: RejectedQuestion[] = [];
  const context = {
    spaceName: request.spaceName,
    courseTitle: request.kind === 'paper' ? request.courseTitle : null,
    difficulty: request.kind === 'paper' ? request.blueprint.difficulty : ('any' as const),
    concepts: request.concepts,
    subtype: request.kind === 'variant' ? request.subtype : null,
    variant,
  };
  const avoid = [
    ...job.produced.map((question) => question.stem),
    ...duplicates.stems.slice(0, 12).map((entry) => entry.stem.slice(0, 120)),
  ];
  const message = buildGenerationMessage(context, batch, job.evidence, avoid);
  const checkOptions = {
    batch,
    evidence: job.evidence,
    concepts: variant ? [] : request.concepts,
    fixedConcepts: variant ? request.concepts : null,
    subtype: context.subtype,
    duplicates: {
      ...duplicates,
      hashes: new Set([...duplicates.hashes]),
    },
    hash: questionContentHash,
    batchNo,
  };
  let check;
  try {
    const system = generationSystemPrompt(variant);
    check = checkGeneration(
      await call(system, message, PRACTICE_LIMITS.generationOutputTokens, GENERATION_TIMEOUT_MS),
      checkOptions,
    );
    if (!check.parsed && budget() && job.calls + usage.calls + 2 <= job.callCap) {
      // One repair call when the reply was not JSON at all (the review still fits the cap).
      rejected.push(...check.rejected);
      check = checkGeneration(
        await call(
          system,
          `${message}${REPAIR_SUFFIX}`,
          PRACTICE_LIMITS.generationOutputTokens,
          GENERATION_TIMEOUT_MS,
        ),
        checkOptions,
      );
    }
  } catch (error) {
    return { accepted: [], rejected, error: failure(error), model };
  }
  rejected.push(...check.rejected);
  if (check.accepted.length === 0) return { accepted: [], rejected, error: null, model };
  const reviewRejected = (
    reason: 'review_missing' | 'review_invalid',
    candidates: CandidateQuestion[],
  ) =>
    rejected.push(
      ...candidates.map((candidate) => ({
        batch: batchNo,
        stage: 'review' as const,
        reason,
        stem: candidate.content.stem.slice(0, 80),
      })),
    );
  if (!budget()) {
    reviewRejected('review_missing', check.accepted);
    return { accepted: [], rejected, error: null, model };
  }
  let verdicts;
  try {
    verdicts = parseReview(
      await call(
        REVIEW_SYSTEM_PROMPT,
        buildReviewMessage(check.accepted, job.evidence),
        PRACTICE_LIMITS.reviewOutputTokens,
        REVIEW_TIMEOUT_MS,
      ),
      new Set(check.accepted.map((candidate) => candidate.id)),
    );
  } catch (error) {
    const code = failure(error);
    reviewRejected('review_missing', check.accepted);
    return { accepted: [], rejected, error: code, model };
  }
  if (!verdicts) {
    reviewRejected('review_invalid', check.accepted);
    return { accepted: [], rejected, error: null, model };
  }
  const accepted: ReviewedCandidate[] = [];
  for (const candidate of check.accepted) {
    const verdict = verdicts.get(candidate.id);
    if (verdict?.status === 'passed') {
      accepted.push({ ...candidate, review: verdict.notes });
    } else {
      rejected.push({
        batch: batchNo,
        stage: 'review',
        reason: verdict ? 'review_rejected' : 'review_missing',
        stem: candidate.content.stem.slice(0, 80),
        ...(verdict?.notes ? { note: verdict.notes.slice(0, 200) } : {}),
      });
    }
  }
  return { accepted, rejected, error: null, model };
}

/** Store a finished step: the passed questions join the bank with the job update. */
async function finishStep(
  db: StudyDb,
  ownerId: string,
  job: PracticeJobRow,
  token: string,
  outcome: StepOutcome,
  usage: StepUsage,
): Promise<boolean> {
  return db.withTransaction(async (tx) => {
    const locked = await lockClaimedJob(tx, ownerId, job.id, token);
    if (!locked) return false;
    const rejected = [...locked.rejected, ...outcome.rejected];
    const produced = [...locked.produced];
    if (outcome.accepted.length) {
      const stageId = locked.request.kind === 'paper' ? locked.request.blueprint.stageId : null;
      const outcomes = await insertQuestionsTx(
        tx,
        ownerId,
        locked.spaceId,
        outcome.accepted.map((candidate) => ({
          content: {
            ...candidate.content,
            source: generationSource(locked, candidate, outcome.model),
          },
          verification: 'unverified' as const,
          origin: 'ai_generated' as const,
          stageId,
        })),
      );
      outcome.accepted.forEach((candidate, index) => {
        const stored = outcomes[index]!;
        if (stored.status !== 'created') {
          rejected.push({
            batch: locked.steps,
            stage: 'program',
            reason: 'duplicate',
            stem: candidate.content.stem.slice(0, 80),
          });
          return;
        }
        produced.push({
          questionId: stored.id,
          version: 1,
          type: candidate.content.type,
          ...(candidate.content.subtype ? { subtype: candidate.content.subtype } : {}),
          stem: candidate.content.stem.slice(0, 160),
          concepts: candidate.content.concepts,
          refs: candidate.refs,
          hint: candidate.hint,
          similarity: candidate.similarity,
          review: candidate.review.slice(0, 300),
          batch: locked.steps,
        });
      });
    }
    const calls = locked.calls + usage.calls;
    const left = remainingTargets(locked.request.targets, produced);
    const status =
      left.length === 0
        ? 'completed'
        : outcome.error || calls + 2 > locked.callCap
          ? 'stopped'
          : 'pending';
    await finishPracticeStep(tx, ownerId, job.id, {
      status,
      produced,
      rejected,
      calls,
      inputTokens: locked.inputTokens + usage.inputTokens,
      outputTokens: locked.outputTokens + usage.outputTokens,
      usageKnown: locked.usageKnown && usage.known,
      models: [...new Set([...locked.models, outcome.model])],
      lastError: status === 'stopped' ? (outcome.error ?? 'budget') : null,
    });
    return true;
  });
}

function errorResponse(error: unknown, headers: Headers): Response {
  if (error instanceof StudyError) {
    return Response.json(
      { error: error.code, ...error.details },
      { status: error.status, headers },
    );
  }
  throw error;
}

/**
 * Run the next step of a pending job. A job that is not pending, or whose
 * step another request holds, is returned unchanged without a model call.
 */
export async function runPracticeStep(
  req: Request,
  db: StudyDb,
  ownerId: string,
  input: { jobId: string; body: unknown },
  headers: Headers,
  deps: PracticeDependencies = {},
): Promise<Response> {
  const current = await getPracticeJob(db, ownerId, input.jobId);
  if (current.status !== 'pending') {
    return Response.json({ job: jobView(current), ran: false }, { status: 200, headers });
  }
  const binding = await bindingFor(req, input.body);
  return runIndependentHeavyTaskRequest(req, 'study-practice', async (leaseSignal) => {
    try {
      const claim = await claimPracticeStep(db, ownerId, input.jobId);
      if (!claim) {
        return Response.json(
          { job: await getPracticeJobView(db, ownerId, input.jobId), ran: false },
          { status: 200, headers },
        );
      }
      const job = claim.job;
      const usage: StepUsage = { calls: 0, inputTokens: 0, outputTokens: 0, known: true };
      const batch = nextBatch(job.request.targets, job.produced);
      let outcome: StepOutcome = {
        accepted: [],
        rejected: [],
        error: null,
        model: modelName(binding),
      };
      if (batch.length && job.calls + 2 <= job.callCap) {
        try {
          outcome = await runBatch(
            req,
            db,
            ownerId,
            job,
            batch,
            binding,
            AbortSignal.any([req.signal, leaseSignal]),
            usage,
            deps,
          );
        } catch (error) {
          await finishStep(
            db,
            ownerId,
            job,
            claim.token,
            { ...outcome, error: 'internal' },
            usage,
          ).catch(() => undefined);
          throw error;
        }
      }
      const stored = await finishStep(db, ownerId, job, claim.token, outcome, usage);
      if (outcome.error) log.warn('practice step failed', { code: outcome.error });
      return Response.json(
        { job: await getPracticeJobView(db, ownerId, input.jobId), ran: stored },
        { status: 200, headers },
      );
    } catch (error) {
      return errorResponse(error, headers);
    }
  });
}
