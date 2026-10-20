/**
 * Explanations of one wrong question on request (learning plan B13). Runs in
 * web, driven by the page (like B11 practice): the page creates an
 * explanation after the student chose a form, then asks for it to be run
 * while it is pending.
 *
 * - The request is frozen on the server when it is created: the question as
 *   last answered wrongly, the student's answer and grading (the B10 chat
 *   context), a few passages of the subject's current indexed materials
 *   (keyword retrieval, B11) and the student's explanation preferences
 *   (Memory on). Nothing the client sends becomes part of it.
 * - The same inputs, form and language return the saved explanation (no
 *   model call) unless the student asks for a new one; a newer wrong answer,
 *   a regrade, other materials or other preferences are different inputs.
 * - A run makes at most the form's call cap (one repair of a reply that was
 *   not JSON at all), checks the output by program and stores it only while
 *   it still holds the lease and the explanation is pending — a cancel in
 *   between stores nothing. Leaving the page does not stop a run; the
 *   result is there when the student comes back.
 * - A full course is not written here: the page hands the request to the
 *   normal course generation, which reports its job and then its course
 *   back; the course joins the subject once.
 */
import { createHash, randomUUID } from 'node:crypto';

import { generateWidgetContent, type SceneOutline } from '@openmaic/generation';
import type { Queryable } from '@openmaic/storage/document/pg';

import { supportedLocales } from '@/lib/i18n/locales';
import { createLogger } from '@/lib/logger';
import {
  GatewayError,
  ModelSelectionError,
  gateway,
  resolveRequestBinding,
  userText,
  type ModelBinding,
  type ModelGateway,
} from '@/lib/model-gateway';
import { runIndependentHeavyTaskRequest } from '@/lib/server/heavy-task-admission/independent-request';
import { resolveExplanationPreferences } from '@/lib/server/study/memory/context';
import {
  practiceScope,
  retrievalSignature,
  variantEvidence,
} from '@/lib/server/study/practice/evidence';
import { requireQuestionSpace } from '@/lib/server/study/questions/repository';
import {
  StudyError,
  linkStudySpaceCourse,
  type StudyDb,
} from '@/lib/server/study/spaces/repository';
import {
  assertSpace,
  findItemSpace,
  readOccurrences,
} from '@/lib/server/study/wrongbook/repository';
import { wrongItemChatContext } from '@/lib/server/study/wrongbook/service';
import {
  EXPLANATION_LIMITS,
  isLightFormat,
  type CourseMedia,
  type ExplanationContent,
  type ExplanationCreateResult,
  type ExplanationDetail,
  type ExplanationError,
  type ExplanationFormat,
  type ExplanationPassage,
  type ExplanationRequest,
  type ExplanationSummary,
} from '@/lib/study/explanations/contracts';
import {
  REPAIR_SUFFIX,
  buildExplanationMessage,
  checkInteractivePage,
  checkInteractivePlan,
  checkTextExplanation,
  checkWhiteboardExplanation,
  interactivePlanSystemPrompt,
  languageName,
  textSystemPrompt,
  whiteboardSystemPrompt,
} from '@/lib/study/explanations/generation';
import { isWrong } from '@/lib/study/wrongbook/contracts';

import {
  claimExplanation,
  countStartedToday,
  createExplanationId,
  deleteExplanationRow,
  findExplanationByKey,
  findOpenCourse,
  findReusable,
  finishExplanation,
  getExplanation,
  insertExplanation,
  listExplanationRows,
  lockExplanation,
  setCourseJob,
  setCourseStage,
  setExplanationStatus,
  type ExplanationRow,
  type RunUpdate,
} from './repository';

const log = createLogger('StudyExplanations');

export interface ExplanationDependencies {
  gateway?: Pick<ModelGateway, 'complete'>;
  /** The classroom's interactive-page generator (tests replace it). */
  generatePage?: typeof generateWidgetContent;
}

function hashOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function clip(value: string, max: number): string {
  const chars = Array.from(value.replace(/\s+/gu, ' ').trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

export function isExplanationLanguage(value: unknown): value is string {
  return typeof value === 'string' && supportedLocales.some((locale) => locale.code === value);
}

// ── views ───────────────────────────────────────────────────────────────────

export function summaryOf(row: ExplanationRow, now = Date.now()): ExplanationSummary {
  const light = isLightFormat(row.format);
  return {
    id: row.id,
    spaceId: row.spaceId,
    itemId: row.itemId,
    format: row.format,
    status: row.status,
    title: row.title,
    stem: clip(row.request.question.stem, 160),
    concepts: row.request.question.concepts,
    running:
      row.status === 'pending' && row.leaseUntil !== null && Date.parse(row.leaseUntil) > now,
    attempts: row.attempts,
    canRetry:
      (row.status === 'failed' || row.status === 'cancelled') &&
      (light ? row.attempts < EXPLANATION_LIMITS.attempts : row.stageId === null),
    lastError: row.lastError,
    calls: row.calls,
    callCap: row.callCap,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    model: row.model,
    jobId: row.jobId,
    stageId: row.stageId,
    media: row.request.course?.media ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function detailOf(row: ExplanationRow, now = Date.now()): ExplanationDetail {
  const cited = new Set(row.content?.refs ?? []);
  return {
    ...summaryOf(row, now),
    content: row.content,
    sources: row.request.passages
      .filter((passage) => cited.has(passage.id))
      .map(({ text: _text, ...source }) => source),
    preferencesUsed: row.request.preferences !== null,
    requirement: row.request.course?.requirement ?? null,
  };
}

// ── creating ────────────────────────────────────────────────────────────────

async function passagesFor(
  db: StudyDb,
  ownerId: string,
  spaceId: string,
  question: Parameters<typeof variantEvidence>[3],
): Promise<ExplanationPassage[]> {
  const signature = await retrievalSignature(db);
  const scope = await practiceScope(db, ownerId, spaceId, signature);
  if (scope.length === 0) return [];
  const evidence = await db.withTransaction((tx) =>
    variantEvidence(tx, ownerId, scope.slice(0, 6), question),
  );
  const passages: ExplanationPassage[] = [];
  for (const piece of evidence) {
    if (piece.kind !== 'material' || !piece.materialId || !piece.versionId) continue;
    passages.push({
      id: `M${passages.length + 1}`,
      text: clip(piece.text, EXPLANATION_LIMITS.passageChars),
      materialId: piece.materialId,
      versionId: piece.versionId,
      versionNo: piece.versionNo ?? 0,
      page: piece.page ?? null,
      title: clip(piece.title ?? '', 80),
    });
    if (passages.length === EXPLANATION_LIMITS.evidencePassages) break;
  }
  return passages;
}

function defaultRequirement(request: Omit<ExplanationRequest, 'course'>): string {
  const topic = request.question.concepts.length
    ? request.question.concepts.slice(0, 3).join('、')
    : '这道题涉及的知识点';
  return clip(
    `请围绕「${topic}」生成一节专项课程，帮我弄懂下面这道我做错的题，并配一两道类似的例题。` +
      `题目：${clip(request.question.stem, 200)} 我的作答：${clip(request.studentAnswer, 120)}`,
    EXPLANATION_LIMITS.requirementChars,
  );
}

/** The frozen request for one wrong item (its newest wrong answer). */
async function buildRequest(
  db: StudyDb,
  ownerId: string,
  itemId: string,
  format: ExplanationFormat,
  language: string,
  course: { requirement: string | null; media: CourseMedia } | null,
): Promise<{ spaceId: string; request: ExplanationRequest; reuseKey: string }> {
  const { spaceId } = await findItemSpace(db, ownerId, itemId);
  const space = await requireQuestionSpace(db, ownerId, spaceId, { writable: true });
  const { context } = await wrongItemChatContext(db, ownerId, spaceId, itemId);
  const occurrence = (await readOccurrences(db, ownerId, itemId)).find((candidate) =>
    isWrong(candidate.outcome),
  );
  if (!occurrence) throw new StudyError('STUDY_WRONG_ITEM_NOT_FOUND');
  const passages = await passagesFor(db, ownerId, spaceId, occurrence.question);
  const preferences = await resolveExplanationPreferences(db, ownerId, spaceId);
  const base: Omit<ExplanationRequest, 'course'> = {
    version: 1,
    format,
    language,
    spaceName: space.name,
    question: {
      kind: context.questionType,
      stem: context.question,
      options: context.options ?? [],
      correct: context.correctAnswer ?? null,
      explanation: context.explanation ?? null,
      concepts: context.concepts ?? [],
    },
    where: context.where,
    studentAnswer: context.studentAnswer,
    grading: context.grading,
    sourceKey: occurrence.sourceKey,
    passages,
    preferences,
  };
  const request: ExplanationRequest = course
    ? {
        ...base,
        course: {
          requirement: course.requirement
            ? clip(course.requirement, EXPLANATION_LIMITS.requirementChars)
            : defaultRequirement(base),
          media: course.media,
        },
      }
    : base;
  const reuseKey = hashOf([
    EXPLANATION_LIMITS.policyVersion,
    format,
    language,
    occurrence.sourceKey,
    hashOf([occurrence.question, occurrence.response, occurrence.grading]),
    passages.map((passage) => [passage.versionId, passage.text]),
    preferences?.text ?? null,
  ]);
  return { spaceId, request, reuseKey };
}

export interface CreateExplanationInput {
  itemId: string;
  format: ExplanationFormat;
  language: string;
  consent: boolean;
  /** A new explanation even when a saved one of the same inputs exists. */
  fresh: boolean;
  idempotencyKey: string;
  /** Course only. */
  requirement: string | null;
  media: CourseMedia;
}

export async function createExplanation(
  db: StudyDb,
  ownerId: string,
  input: CreateExplanationInput,
): Promise<ExplanationCreateResult> {
  if (!input.consent) throw new StudyError('STUDY_EXPLANATION_INVALID', { field: 'consent' });
  const requestHash = hashOf([
    input.itemId,
    input.format,
    input.language,
    input.fresh,
    input.requirement,
    input.media,
  ]);
  const earlier = await findExplanationByKey(db, ownerId, input.idempotencyKey);
  if (earlier) {
    if (earlier.requestHash !== requestHash) throw new StudyError('STUDY_IDEMPOTENCY_CONFLICT');
    return { explanation: detailOf(earlier), reused: false };
  }
  const light = isLightFormat(input.format);
  const { spaceId, request, reuseKey } = await buildRequest(
    db,
    ownerId,
    input.itemId,
    input.format,
    input.language,
    light ? null : { requirement: input.requirement, media: input.media },
  );
  if (light && !input.fresh) {
    const saved = await findReusable(db, ownerId, reuseKey);
    if (saved) return { explanation: detailOf(saved), reused: true };
  }
  if (!light) {
    // One course per item at a time: a waiting one, or one whose course is still in the subject.
    const open = await findOpenCourse(db, ownerId, input.itemId);
    if (open && (open.status === 'pending' || (await courseLinked(db, ownerId, open)))) {
      return { explanation: detailOf(open), reused: true };
    }
  } else if ((await countStartedToday(db, ownerId)) >= EXPLANATION_LIMITS.perDay) {
    throw new StudyError('STUDY_EXPLANATION_LIMIT', { maximum: EXPLANATION_LIMITS.perDay });
  }
  const id = createExplanationId();
  const inserted = await insertExplanation(db, ownerId, {
    id,
    spaceId,
    itemId: input.itemId,
    format: input.format,
    request,
    reuseKey,
    idempotencyKey: input.idempotencyKey,
    requestHash,
  });
  if (inserted) {
    log.info('explanation created', { format: input.format, passages: request.passages.length });
    return { explanation: detailOf(await getExplanation(db, ownerId, id)), reused: false };
  }
  const raced = await findExplanationByKey(db, ownerId, input.idempotencyKey);
  if (!raced || raced.requestHash !== requestHash) {
    throw new StudyError('STUDY_IDEMPOTENCY_CONFLICT');
  }
  return { explanation: detailOf(raced), reused: false };
}

// ── reading, cancelling, retrying, deleting ─────────────────────────────────

export async function listExplanations(
  db: Queryable,
  ownerId: string,
  filter: { spaceId: string; itemId?: string },
): Promise<ExplanationSummary[]> {
  await assertSpace(db, ownerId, filter.spaceId);
  const now = Date.now();
  return (await listExplanationRows(db, ownerId, filter)).map((row) => summaryOf(row, now));
}

export async function getExplanationDetail(
  db: Queryable,
  ownerId: string,
  id: string,
): Promise<ExplanationDetail> {
  return detailOf(await getExplanation(db, ownerId, id));
}

export async function cancelExplanation(
  db: Queryable,
  ownerId: string,
  id: string,
): Promise<ExplanationDetail> {
  const row = await getExplanation(db, ownerId, id);
  if (row.status === 'cancelled') return detailOf(row);
  const updated = await setExplanationStatus(db, ownerId, id, ['pending'], 'cancelled');
  if (!updated) throw new StudyError('STUDY_EXPLANATION_STATE', { status: row.status });
  return detailOf(updated);
}

/** Run a failed or cancelled explanation again (same frozen request), within the try limit. */
export async function retryExplanation(
  db: Queryable,
  ownerId: string,
  id: string,
): Promise<ExplanationDetail> {
  const row = await getExplanation(db, ownerId, id);
  if (!summaryOf(row).canRetry) {
    throw new StudyError('STUDY_EXPLANATION_STATE', { status: row.status });
  }
  if (!isLightFormat(row.format)) {
    // A course starts again through course generation, which reports its new job.
    return detailOf(row);
  }
  const updated = await setExplanationStatus(db, ownerId, id, ['failed', 'cancelled'], 'pending', {
    attempts: row.attempts + 1,
    lastError: null,
  });
  if (!updated) throw new StudyError('STUDY_EXPLANATION_STATE', { status: row.status });
  return detailOf(updated);
}

/** Delete an explanation. A course it started stays in the subject (remove it there). */
export async function deleteExplanation(db: Queryable, ownerId: string, id: string): Promise<void> {
  if (!(await deleteExplanationRow(db, ownerId, id))) {
    throw new StudyError('STUDY_EXPLANATION_NOT_FOUND');
  }
}

// ── courses ─────────────────────────────────────────────────────────────────

async function courseLinked(db: Queryable, ownerId: string, row: ExplanationRow) {
  if (!row.stageId) return false;
  const result = await db.query(
    `SELECT 1 FROM study_space_courses l
       JOIN stage_meta m ON m.stage_id = l.stage_id AND m.owner_id = l.owner_id
      WHERE l.owner_id = $1 AND l.space_id = $2 AND l.stage_id = $3 AND m.deleted_at IS NULL`,
    [ownerId, row.spaceId, row.stageId],
  );
  return result.rows.length > 0;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAGE_ID = /^[A-Za-z0-9_-]{1,200}$/;

/**
 * Course generation reports back: first its job (so the page can show and
 * cancel it), then its course, which joins the subject — once. A second
 * course for the same explanation is refused while the first is still in
 * the subject, so a cancelled and restarted generation never adds two.
 */
export async function attachCourse(
  db: StudyDb,
  ownerId: string,
  id: string,
  input: { jobId?: string; stageId?: string },
): Promise<{ explanation: ExplanationDetail; created: boolean }> {
  const row = await getExplanation(db, ownerId, id);
  if (row.format !== 'course') throw new StudyError('STUDY_EXPLANATION_INVALID', { field: 'id' });
  if (input.jobId !== undefined) {
    if (!UUID.test(input.jobId))
      throw new StudyError('STUDY_EXPLANATION_INVALID', { field: 'jobId' });
    if (row.jobId === input.jobId) return { explanation: detailOf(row), created: false };
    if (row.stageId && (await courseLinked(db, ownerId, row))) {
      throw new StudyError('STUDY_EXPLANATION_COURSE_EXISTS', { stageId: row.stageId });
    }
    if (row.stageId) {
      // Its course was removed from the subject: the explanation may start another.
      await db.query(
        `UPDATE study_explanations SET stage_id = NULL, updated_at = clock_timestamp()
          WHERE owner_id = $1 AND id = $2`,
        [ownerId, id],
      );
    }
    const updated = await setCourseJob(db, ownerId, id, input.jobId);
    if (!updated) throw new StudyError('STUDY_EXPLANATION_STATE', { status: row.status });
    return { explanation: detailOf(updated), created: false };
  }
  const stageId = input.stageId ?? '';
  if (!STAGE_ID.test(stageId))
    throw new StudyError('STUDY_EXPLANATION_INVALID', { field: 'stageId' });
  if (row.stageId === stageId) {
    const { created } = await linkStudySpaceCourse(db, ownerId, row.spaceId, stageId, 'generation');
    return { explanation: detailOf(await getExplanation(db, ownerId, id)), created };
  }
  if (row.stageId && (await courseLinked(db, ownerId, row))) {
    throw new StudyError('STUDY_EXPLANATION_COURSE_EXISTS', { stageId: row.stageId });
  }
  if (row.status === 'cancelled')
    throw new StudyError('STUDY_EXPLANATION_STATE', { status: row.status });
  const { created } = await linkStudySpaceCourse(db, ownerId, row.spaceId, stageId, 'generation');
  await db.withTransaction(async (tx) => {
    await lockExplanation(tx, ownerId, id);
    await setCourseStage(tx, ownerId, id, stageId);
  });
  log.info('explanation course linked', { created });
  return { explanation: detailOf(await getExplanation(db, ownerId, id)), created };
}

// ── running ─────────────────────────────────────────────────────────────────

async function bindingFor(req: Request, body: unknown): Promise<ModelBinding> {
  try {
    const binding = await resolveRequestBinding(req, body, 'study-explanation');
    if (!binding.credentialReady) {
      throw new StudyError('STUDY_EXPLANATION_MODEL_UNAVAILABLE', { reason: 'credential' });
    }
    return binding;
  } catch (error) {
    if (error instanceof ModelSelectionError || error instanceof GatewayError) {
      throw new StudyError('STUDY_EXPLANATION_MODEL_UNAVAILABLE', { reason: error.code });
    }
    throw error;
  }
}

function modelName(binding: ModelBinding): string {
  return binding.source === 'platform' && binding.providerId && binding.modelId
    ? `${binding.providerId}:${binding.modelId}`
    : binding.modelString;
}

class BudgetSpent extends Error {}

interface RunUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

/** One try: the model calls of the form, then the program checks. */
async function produce(
  row: ExplanationRow,
  binding: ModelBinding,
  ownerId: string,
  signal: AbortSignal,
  usage: RunUsage,
  deps: ExplanationDependencies,
): Promise<{ content: ExplanationContent | null; error: ExplanationError | null }> {
  const request = row.request;
  const known = new Set(request.passages.map((passage) => passage.id));
  const fallbackTitle = request.question.concepts[0] ?? '专项讲解';
  const message = buildExplanationMessage(request);
  const requestId = randomUUID();
  const call = async (
    system: string,
    user: string,
    kind: keyof typeof EXPLANATION_LIMITS.outputTokens,
  ): Promise<string> => {
    if (usage.calls >= row.callCap) throw new BudgetSpent();
    usage.calls += 1;
    const result = await (deps.gateway ?? gateway).complete(
      binding,
      {
        system,
        messages: [userText(user)],
        maxOutputTokens: EXPLANATION_LIMITS.outputTokens[kind],
        temperature: kind === 'page' ? 0.5 : 0.4,
      },
      {
        source: 'study-explanation',
        signal: AbortSignal.any([signal, AbortSignal.timeout(EXPLANATION_LIMITS.timeoutMs[kind])]),
        ownerId,
        retry: 'none',
        usage: {
          requestId,
          eventKey: `explanation:${row.id}:${row.attempts}:${usage.calls}`,
        },
      },
    );
    usage.inputTokens += result.usage.inputTokens;
    usage.outputTokens += result.usage.outputTokens;
    return result.text;
  };
  /** One call, and one repair when the reply was not JSON at all. */
  const checked = async <T>(
    system: string,
    kind: 'text' | 'whiteboard' | 'plan',
    check: (reply: string) => { ok: true; content: T } | { ok: false; parsed: boolean },
  ): Promise<T | null> => {
    let result = check(await call(system, message, kind));
    if (!result.ok && !result.parsed && usage.calls < row.callCap - (kind === 'plan' ? 1 : 0)) {
      result = check(await call(system, `${message}${REPAIR_SUFFIX}`, kind));
    }
    return result.ok ? result.content : null;
  };
  try {
    switch (row.format) {
      case 'text': {
        const content = await checked(textSystemPrompt(request), 'text', (reply) =>
          checkTextExplanation(reply, known, fallbackTitle),
        );
        return content ? { content, error: null } : { content: null, error: 'invalid_output' };
      }
      case 'whiteboard': {
        const content = await checked(whiteboardSystemPrompt(request), 'whiteboard', (reply) =>
          checkWhiteboardExplanation(reply, known, fallbackTitle),
        );
        return content ? { content, error: null } : { content: null, error: 'invalid_output' };
      }
      case 'interactive': {
        const plan = await checked(interactivePlanSystemPrompt(request), 'plan', (reply) =>
          checkInteractivePlan(reply, known, fallbackTitle),
        );
        if (!plan) return { content: null, error: 'invalid_output' };
        const outline: SceneOutline = {
          id: `explanation-${row.id}`,
          type: 'interactive',
          title: plan.title,
          description: plan.description,
          keyPoints: plan.keyPoints,
          order: 1,
          widgetType: plan.widgetType,
          widgetOutline:
            plan.widgetType === 'simulation'
              ? { concept: plan.concept, keyVariables: plan.variables }
              : { concept: plan.concept, diagramType: 'flowchart' },
        };
        const page = await (deps.generatePage ?? generateWidgetContent)(
          outline,
          (system, user) => call(system, user, 'page'),
          `请用${languageName(request.language)}编写页面上的全部文字。`,
        );
        const content = checkInteractivePage(plan, page?.html ?? null);
        return content ? { content, error: null } : { content: null, error: 'invalid_output' };
      }
      default:
        return { content: null, error: 'internal' };
    }
  } catch (error) {
    if (error instanceof BudgetSpent) return { content: null, error: 'budget' };
    if (signal.aborted) return { content: null, error: 'interrupted' };
    if (error instanceof GatewayError) {
      return {
        content: null,
        error:
          error.code === 'MODEL_ABORTED' || error.code === 'MODEL_TIMEOUT'
            ? 'timeout'
            : 'model_error',
      };
    }
    if ((error as Error)?.name === 'TimeoutError' || (error as Error)?.name === 'AbortError') {
      return { content: null, error: 'timeout' };
    }
    throw error;
  }
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
 * Run a pending explanation with the student's model. One that is not
 * pending, or that another request is running, comes back unchanged without
 * a model call. Responds with `{ explanation, ran }`.
 */
export async function runExplanation(
  req: Request,
  db: StudyDb,
  ownerId: string,
  input: { id: string; body: unknown },
  headers: Headers,
  deps: ExplanationDependencies = {},
): Promise<Response> {
  const current = await getExplanation(db, ownerId, input.id);
  if (current.status !== 'pending' || !isLightFormat(current.format)) {
    return Response.json({ explanation: detailOf(current), ran: false }, { status: 200, headers });
  }
  const binding = await bindingFor(req, input.body);
  return runIndependentHeavyTaskRequest(req, 'study-explanation', async (leaseSignal) => {
    try {
      const claim = await claimExplanation(db, ownerId, input.id);
      if (!claim) {
        return Response.json(
          { explanation: await getExplanationDetail(db, ownerId, input.id), ran: false },
          { status: 200, headers },
        );
      }
      const usage: RunUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };
      let outcome: { content: ExplanationContent | null; error: ExplanationError | null };
      try {
        outcome = await produce(claim.row, binding, ownerId, leaseSignal, usage, deps);
      } catch (error) {
        outcome = { content: null, error: 'internal' };
        log.error('explanation run failed', { error: (error as Error)?.message });
      }
      const update: RunUpdate = {
        status: outcome.content ? 'ready' : 'failed',
        title: outcome.content?.title ?? null,
        content: outcome.content,
        calls: usage.calls,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        model: modelName(binding),
        lastError: outcome.content ? null : (outcome.error ?? 'invalid_output'),
      };
      const stored = await finishExplanation(db, ownerId, input.id, claim.token, update).catch(
        () => false,
      );
      if (outcome.error) log.warn('explanation not written', { code: outcome.error });
      else log.info('explanation written', { format: claim.row.format, calls: usage.calls });
      const explanation = await getExplanationDetail(db, ownerId, input.id).catch(() => null);
      if (!explanation) throw new StudyError('STUDY_EXPLANATION_NOT_FOUND');
      return Response.json({ explanation, ran: stored }, { status: 200, headers });
    } catch (error) {
      return errorResponse(error, headers);
    }
  });
}
