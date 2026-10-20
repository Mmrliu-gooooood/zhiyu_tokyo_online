/**
 * Assisted grading of open items (learning plan B09). Runs in web, one item
 * per request, driven by the report page: after submission (choice items are
 * already scored) the page asks for the next waiting item until none is
 * left; a failed item is retried only when the student asks.
 *
 * Per item: claim its grading row (so repeats and concurrent requests never
 * grade it twice), read the frozen question, guide and submitted answer from
 * the database (nothing score-bearing comes from the client), let the
 * program compare a calculation's final answer, and ask the student's
 * selected model — through the gateway, under the synchronous heavy-task
 * lease — only for the points left. A result is stored only after the
 * program checked every point and added up the total; anything else is a
 * failed grading, never a score.
 */
import { randomUUID } from 'node:crypto';

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
import { getAttemptView, paperItemWithKey } from '@/lib/server/study/exams/repository';
import { projectExamAttempt } from '@/lib/server/study/memory/projector';
import { invalidateAttemptSummary } from '@/lib/server/study/memory/summary';
import { StudyError, type StudyDb } from '@/lib/server/study/spaces/repository';
import {
  isOpenAnswer,
  type AttemptAnswers,
  type GradingResult,
} from '@/lib/study/assessments/contracts';
import {
  OPEN_GRADER_VERSION,
  OPEN_GRADING_LIMITS,
  OPEN_GRADING_SYSTEM_PROMPT,
  buildOpenGradingPrompt,
  combineOpenGrading,
  parseOpenGradingOutput,
  type ModelGrading,
  type ProgramDecision,
} from '@/lib/study/assessments/open-grading';
import type { Queryable } from '@openmaic/storage/document/pg';

import { EQUIVALENCE_PROGRAM, compareFinalAnswers } from './equivalence';
import {
  addReview,
  addSelfGrade,
  claimGrading,
  finishGrading,
  type ClaimedGrading,
  type GradingUsage,
} from './repository';

const log = createLogger('StudyGrading');

/** One model call may take this long before the grading counts as failed (and can be retried). */
const MODEL_TIMEOUT_MS = 90_000;

export interface GradingDependencies {
  gateway?: Pick<ModelGateway, 'complete'>;
}

async function submittedAttempt(
  db: Queryable,
  ownerId: string,
  attemptId: string,
): Promise<{ paperId: string; answers: AttemptAnswers }> {
  const result = await db.query<{ paper_id: string; status: string; answers: unknown }>(
    `SELECT paper_id, status, answers FROM study_exam_attempts WHERE owner_id = $1 AND id = $2`,
    [ownerId, attemptId],
  );
  const row = result.rows[0];
  if (!row) throw new StudyError('STUDY_ATTEMPT_NOT_FOUND');
  if (row.status !== 'submitted') throw new StudyError('STUDY_GRADING_NOT_FOUND');
  const answers = (typeof row.answers === 'string' ? JSON.parse(row.answers) : row.answers) ?? {};
  return { paperId: row.paper_id, answers: answers as AttemptAnswers };
}

async function waitingCount(db: Queryable, ownerId: string, attemptId: string): Promise<number> {
  const result = await db.query<{ n: string | number }>(
    `SELECT count(*) AS n FROM study_exam_gradings
      WHERE owner_id = $1 AND attempt_id = $2 AND status IN ('pending', 'running')`,
    [ownerId, attemptId],
  );
  return Number(result.rows[0]?.n ?? 0);
}

async function bindingFor(req: Request, body: unknown): Promise<ModelBinding> {
  const binding = await resolveRequestBinding(req, body, 'study-grade');
  if (!binding.credentialReady) {
    throw new StudyError('STUDY_GRADING_MODEL_UNAVAILABLE', { reason: 'credential' });
  }
  return binding;
}

type Graded =
  | {
      status: 'succeeded';
      earned: number;
      result: GradingResult;
      grader: { version: string; model: string | null; program: string | null };
    }
  | {
      status: 'failed';
      error: string;
      grader: { version: string; model: string | null; program: string | null } | null;
    };

/** Grade one claimed item. Never throws for model or output problems: they become a failed grading. */
async function gradeClaimed(
  req: Request,
  db: StudyDb,
  ownerId: string,
  attemptId: string,
  claim: ClaimedGrading,
  body: unknown,
  signal: AbortSignal,
  usage: GradingUsage,
  deps: GradingDependencies,
): Promise<Graded> {
  const { paperId, answers } = await submittedAttempt(db, ownerId, attemptId);
  const item = await paperItemWithKey(db, ownerId, paperId, claim.position);
  const answer = answers[String(claim.position)];
  if (!item || item.type !== 'short_answer' || !item.guide || !isOpenAnswer(answer)) {
    return { status: 'failed', error: 'item_unavailable', grader: null };
  }
  const guide = item.guide;
  const rubric = guide.rubric;
  const program: ProgramDecision[] = [];
  let finalCheck: GradingResult['finalCheck'] = null;
  const finalCriterion = rubric.find((criterion) => criterion.final);
  if (finalCriterion && guide.finalAnswer) {
    if (!answer.final) {
      finalCheck = 'missing';
    } else {
      finalCheck = await compareFinalAnswers(answer.final, guide.finalAnswer);
      if (finalCheck === 'equal' || finalCheck === 'not_equal') {
        program.push({
          id: finalCriterion.id,
          awarded: finalCheck === 'equal' ? finalCriterion.points : 0,
          note:
            finalCheck === 'equal'
              ? '最终答案与参考答案等价（程序判定）。'
              : '最终答案与参考答案不等价（程序判定）。',
        });
      }
    }
  }
  const undecided = rubric.filter(
    (criterion) => !program.some((decision) => decision.id === criterion.id),
  );
  const graderBase = {
    version: OPEN_GRADER_VERSION,
    program: program.length ? EQUIVALENCE_PROGRAM : null,
  };
  let model: ModelGrading | null = null;
  let modelString: string | null = null;
  if (undecided.length) {
    let binding: ModelBinding;
    try {
      binding = await bindingFor(req, body);
    } catch (error) {
      if (
        error instanceof StudyError ||
        error instanceof ModelSelectionError ||
        error instanceof GatewayError
      ) {
        return {
          status: 'failed',
          error: 'model_unavailable',
          grader: { ...graderBase, model: null },
        };
      }
      throw error;
    }
    // Record the model that actually graded (a platform default names its alias).
    modelString =
      binding.source === 'platform' && binding.providerId && binding.modelId
        ? `${binding.providerId}:${binding.modelId}`
        : binding.modelString;
    const prompt = buildOpenGradingPrompt(
      {
        stem: item.stem,
        subtype: item.subtype ?? 'short',
        points: item.points,
        guide,
        rubric,
        answer,
      },
      undecided,
      program,
    );
    const requestId = randomUUID();
    const call = async (message: string): Promise<string> => {
      usage.calls += 1;
      const timeout = AbortSignal.timeout(MODEL_TIMEOUT_MS);
      const result = await (deps.gateway ?? gateway).complete(
        binding,
        {
          system: OPEN_GRADING_SYSTEM_PROMPT,
          messages: [userText(message)],
          maxOutputTokens: OPEN_GRADING_LIMITS.outputTokens,
          temperature: 0,
        },
        {
          source: 'study-grade',
          signal: AbortSignal.any([signal, timeout]),
          ownerId,
          retry: 'none',
          usage: {
            requestId,
            eventKey: `grade:${attemptId}:${claim.position}:${claim.seq}:${claim.tries}:${usage.calls}`,
          },
        },
      );
      usage.inputTokens += result.usage.inputTokens;
      usage.outputTokens += result.usage.outputTokens;
      if (result.usage.inputTokens === 0 && result.usage.outputTokens === 0) usage.known = false;
      return result.text;
    };
    try {
      const first = await call(prompt);
      model = parseOpenGradingOutput(first, undecided);
      if (!model && !looksLikeJson(first)) {
        // One repair call when the reply was not JSON at all (never for out-of-range scores).
        model = parseOpenGradingOutput(
          await call(
            `${prompt}\n\n上一次的输出不是要求的 JSON 对象。请只输出符合格式的 JSON 对象。`,
          ),
          undecided,
        );
      }
    } catch (error) {
      usage.known = false;
      if (signal.aborted && !req.signal.aborted) {
        return {
          status: 'failed',
          error: 'lease_lost',
          grader: { ...graderBase, model: modelString },
        };
      }
      if (error instanceof GatewayError) {
        const code =
          error.code === 'MODEL_ABORTED' || error.code === 'MODEL_TIMEOUT'
            ? 'timeout'
            : 'model_error';
        log.warn('grading model call failed', { code: error.code });
        return { status: 'failed', error: code, grader: { ...graderBase, model: modelString } };
      }
      if ((error as Error)?.name === 'TimeoutError' || (error as Error)?.name === 'AbortError') {
        return {
          status: 'failed',
          error: 'timeout',
          grader: { ...graderBase, model: modelString },
        };
      }
      throw error;
    }
    if (!model) {
      return {
        status: 'failed',
        error: 'invalid_output',
        grader: { ...graderBase, model: modelString },
      };
    }
  }
  const combined = combineOpenGrading(rubric, program, model, finalCheck);
  if (!combined) {
    return {
      status: 'failed',
      error: 'invalid_output',
      grader: { ...graderBase, model: modelString },
    };
  }
  return {
    status: 'succeeded',
    earned: combined.earned,
    result: combined.result,
    grader: { ...graderBase, model: modelString },
  };
}

function looksLikeJson(text: string): boolean {
  try {
    JSON.parse(
      text
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, ''),
    );
    return true;
  } catch {
    return false;
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
 * Grade the next waiting open item of a submitted attempt (or the named one,
 * also when it failed before). Responds with the updated attempt and what
 * happened; when nothing is waiting it changes nothing and calls no model.
 */
export async function gradeNextItem(
  req: Request,
  db: StudyDb,
  ownerId: string,
  input: { attemptId: string; position: number | null; body: unknown },
  headers: Headers,
  deps: GradingDependencies = {},
): Promise<Response> {
  await submittedAttempt(db, ownerId, input.attemptId);
  return runIndependentHeavyTaskRequest(req, 'study-grade', async (leaseSignal) => {
    try {
      const signal = AbortSignal.any([req.signal, leaseSignal]);
      const claim = await claimGrading(db, ownerId, input.attemptId, input.position);
      let graded: {
        position: number;
        status: 'succeeded' | 'failed';
        error: string | null;
      } | null = null;
      if (claim) {
        const usage: GradingUsage = { calls: 0, inputTokens: 0, outputTokens: 0, known: true };
        let outcome: Graded;
        try {
          outcome = await gradeClaimed(
            req,
            db,
            ownerId,
            input.attemptId,
            claim,
            input.body,
            signal,
            usage,
            deps,
          );
        } catch (error) {
          await finishGrading(db, ownerId, input.attemptId, claim, {
            status: 'failed',
            error: 'internal',
            grader: null,
            usage,
          }).catch(() => undefined);
          throw error;
        }
        const stored = await finishGrading(db, ownerId, input.attemptId, claim, {
          ...outcome,
          usage,
        });
        graded = stored
          ? {
              position: claim.position,
              status: outcome.status,
              error: outcome.status === 'failed' ? outcome.error : null,
            }
          : null;
        if (stored && outcome.status === 'succeeded') {
          await projectExamAttempt(db, ownerId, input.attemptId);
          // A regrade changes what the space's Memory summary (B12) was written from.
          if (claim.kind === 'review') {
            await invalidateAttemptSummary(db, ownerId, input.attemptId);
          }
        }
      }
      return Response.json(
        {
          graded,
          waiting: await waitingCount(db, ownerId, input.attemptId),
          attempt: await getAttemptView(db, ownerId, input.attemptId),
        },
        { status: 200, headers },
      );
    } catch (error) {
      return errorResponse(error, headers);
    }
  });
}

/** Ask for another grading of an item; the earlier one is kept. */
export async function requestReview(
  db: StudyDb,
  ownerId: string,
  attemptId: string,
  position: number,
): Promise<{ seq: number }> {
  await submittedAttempt(db, ownerId, attemptId);
  return db.withTransaction((tx) => addReview(tx, ownerId, attemptId, position));
}

/** Record the student's own score for an item (shown apart from the graded score). */
export async function recordSelfGrade(
  db: StudyDb,
  ownerId: string,
  attemptId: string,
  position: number,
  input: { earned: number; note: string | null },
): Promise<{ seq: number }> {
  await submittedAttempt(db, ownerId, attemptId);
  return db.withTransaction((tx) => addSelfGrade(tx, ownerId, attemptId, position, input));
}
