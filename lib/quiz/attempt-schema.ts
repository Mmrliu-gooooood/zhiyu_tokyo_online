import type { QuizAttemptPhase } from '@openmaic/dsl';
import { arraysEqual, toArray, type QuestionResult } from '@/lib/quiz/grading';
import type { QuizAnswers } from '@/lib/quiz/persistence';
import type { QuizQuestion } from '@/lib/types/stage';

export const QUIZ_ATTEMPT_PAYLOAD_VERSION = 2 as const;
export const QUIZ_SNAPSHOT_ALGORITHM_VERSION = 'quiz-snapshot-v1' as const;
export const QUIZ_GRADING_RULE_VERSION = 'quiz-grading-v1' as const;

export interface QuizQuestionSnapshot {
  id: string;
  type: QuizQuestion['type'];
  question: string;
  options?: { value: string; label: string }[];
  answer?: string[];
  analysis?: string;
  commentPrompt?: string;
  points: number;
}

export interface QuizGradeProvenance {
  ruleVersion: string;
  model?: string;
  basis: 'answer-key' | 'rubric' | 'reference-answer' | 'blank-answer';
  gradedAt: string;
}

export type QuizQuestionGrading =
  | { status: 'pending'; error?: { code: string; retryable: true } }
  | { status: 'unavailable'; error: { code: string; retryable: false } }
  | { status: 'graded'; result: QuestionResult; provenance: QuizGradeProvenance };

export interface QuizAttemptPayloadV1 {
  payloadVersion: 1;
  phase: QuizAttemptPhase;
  answers: QuizAnswers;
  results?: QuestionResult[];
}

export interface QuizAttemptPayloadV2 {
  payloadVersion: 2;
  phase: QuizAttemptPhase;
  questionSnapshot: QuizQuestionSnapshot[];
  contentRevision: string;
  answers: QuizAnswers;
  grading: Record<string, QuizQuestionGrading>;
  /** Compatibility projection containing graded facts only. */
  results: QuestionResult[];
  gradeProvenance: Record<string, QuizGradeProvenance>;
  submittedDigest?: string;
  archived?: boolean;
}

export type QuizAttemptPayload = QuizAttemptPayloadV1 | QuizAttemptPayloadV2;

export function createQuizQuestionSnapshot(
  questions: readonly QuizQuestion[],
): QuizQuestionSnapshot[] {
  return questions.map((question) => ({
    id: question.id,
    type: question.type,
    question: question.question,
    ...(question.options ? { options: question.options.map((option) => ({ ...option })) } : {}),
    ...(question.answer ? { answer: [...question.answer] } : {}),
    ...(question.analysis === undefined ? {} : { analysis: question.analysis }),
    ...(question.commentPrompt === undefined ? {} : { commentPrompt: question.commentPrompt }),
    points: question.points ?? 1,
  }));
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function quizContentRevision(snapshot: readonly QuizQuestionSnapshot[]): string {
  return `${QUIZ_SNAPSHOT_ALGORITHM_VERSION}:${fnv1a(JSON.stringify(snapshot))}`;
}

export function quizSubmittedDigest(contentRevision: string, answers: QuizAnswers): string {
  const canonicalAnswers = Object.fromEntries(
    Object.entries(answers).sort(([left], [right]) => left.localeCompare(right)),
  );
  return `quiz-submission-v1:${fnv1a(
    JSON.stringify({ contentRevision, answers: canonicalAnswers }),
  )}`;
}

export function createSubmittedQuizGrading(
  snapshot: readonly QuizQuestionSnapshot[],
  answers: QuizAnswers,
  gradedAt: string,
): Pick<QuizAttemptPayloadV2, 'grading' | 'results' | 'gradeProvenance'> {
  const grading: Record<string, QuizQuestionGrading> = {};
  const results: QuestionResult[] = [];
  const gradeProvenance: Record<string, QuizGradeProvenance> = {};

  const addGraded = (
    question: QuizQuestionSnapshot,
    result: QuestionResult,
    basis: QuizGradeProvenance['basis'],
  ) => {
    const provenance: QuizGradeProvenance = {
      ruleVersion: QUIZ_GRADING_RULE_VERSION,
      basis,
      gradedAt,
    };
    grading[question.id] = { status: 'graded', result, provenance };
    results.push(result);
    gradeProvenance[question.id] = provenance;
  };

  for (const question of snapshot) {
    if (question.type !== 'short_answer') {
      if (!question.answer || question.answer.length === 0) {
        grading[question.id] = {
          status: 'unavailable',
          error: { code: 'MISSING_ANSWER_KEY', retryable: false },
        };
        continue;
      }
      const correct = arraysEqual(toArray(answers[question.id]), question.answer);
      addGraded(
        question,
        {
          questionId: question.id,
          correct,
          status: correct ? 'correct' : 'incorrect',
          earned: correct ? question.points : 0,
        },
        'answer-key',
      );
      continue;
    }

    const rawAnswer = answers[question.id];
    const answer = typeof rawAnswer === 'string' ? rawAnswer : '';
    if (answer.trim().length === 0) {
      addGraded(
        question,
        {
          questionId: question.id,
          correct: false,
          status: 'incorrect',
          earned: 0,
        },
        'blank-answer',
      );
    } else if (!question.commentPrompt?.trim() && !question.answer?.length) {
      grading[question.id] = {
        status: 'unavailable',
        error: { code: 'MISSING_GRADING_BASIS', retryable: false },
      };
    } else {
      grading[question.id] = { status: 'pending' };
    }
  }

  return { grading, results, gradeProvenance };
}

export function applyQuizGrade(
  payload: QuizAttemptPayloadV2,
  result: QuestionResult,
  provenance: QuizGradeProvenance,
): QuizAttemptPayloadV2 {
  const question = payload.questionSnapshot.find((candidate) => candidate.id === result.questionId);
  if (
    !question ||
    !isQuestionResult(result, question.id, question.points) ||
    !isProvenance(provenance)
  ) {
    throw new Error('Invalid graded quiz fact');
  }
  if (payload.grading[question.id]?.status === 'graded') return payload;

  const grading = {
    ...payload.grading,
    [question.id]: { status: 'graded' as const, result, provenance },
  };
  const results: QuestionResult[] = [];
  const gradeProvenance: Record<string, QuizGradeProvenance> = {};
  for (const snapshot of payload.questionSnapshot) {
    const fact = grading[snapshot.id];
    if (fact?.status !== 'graded') continue;
    results.push(fact.result);
    gradeProvenance[snapshot.id] = fact.provenance;
  }
  return { ...payload, grading, results, gradeProvenance };
}

export function isQuizAttemptFullyGraded(payload: QuizAttemptPayloadV2): boolean {
  return payload.questionSnapshot.every(
    (question) => payload.grading[question.id]?.status === 'graded',
  );
}

export function markQuizGradingError(
  payload: QuizAttemptPayloadV2,
  questionId: string,
  code: string,
  retryable: boolean,
): QuizAttemptPayloadV2 {
  if (!payload.questionSnapshot.some((question) => question.id === questionId)) {
    throw new Error('Unknown quiz question');
  }
  if (payload.grading[questionId]?.status === 'graded') return payload;
  return {
    ...payload,
    grading: {
      ...payload.grading,
      [questionId]: retryable
        ? { status: 'pending', error: { code, retryable: true } }
        : { status: 'unavailable', error: { code, retryable: false } },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAnswers(value: unknown): value is QuizAnswers {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (answer) =>
        typeof answer === 'string' ||
        (Array.isArray(answer) && answer.every((item) => typeof item === 'string')),
    )
  );
}

function isQuestionResult(
  value: unknown,
  questionId: string,
  points: number,
): value is QuestionResult {
  if (!isRecord(value)) return false;
  return (
    value.questionId === questionId &&
    (value.correct === true || value.correct === false || value.correct === null) &&
    (value.status === 'correct' || value.status === 'incorrect') &&
    typeof value.earned === 'number' &&
    Number.isFinite(value.earned) &&
    value.earned >= 0 &&
    value.earned <= points &&
    (value.aiComment === undefined ||
      (typeof value.aiComment === 'string' && value.aiComment.length <= 1_000))
  );
}

function isProvenance(value: unknown): value is QuizGradeProvenance {
  if (!isRecord(value)) return false;
  return (
    typeof value.ruleVersion === 'string' &&
    value.ruleVersion.length > 0 &&
    (value.model === undefined || typeof value.model === 'string') &&
    ['answer-key', 'rubric', 'reference-answer', 'blank-answer'].includes(String(value.basis)) &&
    typeof value.gradedAt === 'string' &&
    Number.isFinite(Date.parse(value.gradedAt))
  );
}

function isQuestionSnapshot(value: unknown): value is QuizQuestionSnapshot {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    (value.type === 'single' || value.type === 'multiple' || value.type === 'short_answer') &&
    typeof value.question === 'string' &&
    value.question.length > 0 &&
    value.question.length <= 2_000 &&
    (value.options === undefined ||
      (Array.isArray(value.options) &&
        value.options.every(
          (option) =>
            isRecord(option) &&
            typeof option.value === 'string' &&
            typeof option.label === 'string',
        ))) &&
    (value.answer === undefined ||
      (Array.isArray(value.answer) &&
        value.answer.every((answer) => typeof answer === 'string'))) &&
    (value.analysis === undefined || typeof value.analysis === 'string') &&
    (value.commentPrompt === undefined || typeof value.commentPrompt === 'string') &&
    typeof value.points === 'number' &&
    Number.isInteger(value.points) &&
    value.points > 0 &&
    value.points <= 1_000
  );
}

/** Validate the application-owned v2 payload and its graded-result projection. */
export function validateQuizAttemptPayloadV2(value: unknown): string[] {
  if (!isRecord(value) || value.payloadVersion !== 2) return ['payloadVersion must be 2'];
  if (value.phase !== 'draft' && value.phase !== 'submitted' && value.phase !== 'reviewed') {
    return ['phase is invalid'];
  }
  if (!Array.isArray(value.questionSnapshot) || !value.questionSnapshot.every(isQuestionSnapshot)) {
    return ['questionSnapshot is invalid'];
  }
  const snapshots = value.questionSnapshot as QuizQuestionSnapshot[];
  const ids = snapshots.map((question) => question.id);
  if (new Set(ids).size !== ids.length) return ['questionSnapshot ids must be unique'];
  if (
    typeof value.contentRevision !== 'string' ||
    value.contentRevision !== quizContentRevision(snapshots)
  ) {
    return ['contentRevision does not match questionSnapshot'];
  }
  if (!isAnswers(value.answers)) return ['answers are invalid'];
  if (
    !isRecord(value.grading) ||
    !Array.isArray(value.results) ||
    !isRecord(value.gradeProvenance)
  ) {
    return ['grading projection is invalid'];
  }
  if (
    value.phase !== 'draft' &&
    (typeof value.submittedDigest !== 'string' ||
      value.submittedDigest !== quizSubmittedDigest(value.contentRevision, value.answers))
  ) {
    return ['submittedDigest does not match submitted answers'];
  }

  const gradedResults: QuestionResult[] = [];
  const provenanceProjection: Record<string, QuizGradeProvenance> = {};
  for (const snapshot of snapshots) {
    const grading = value.grading[snapshot.id];
    if (!isRecord(grading)) {
      if (value.phase === 'draft') continue;
      return [`grading is missing for ${snapshot.id}`];
    }
    if (grading.status === 'pending') {
      if (value.phase === 'reviewed') return ['reviewed payload cannot contain pending grading'];
      if (
        grading.error !== undefined &&
        (!isRecord(grading.error) ||
          typeof grading.error.code !== 'string' ||
          grading.error.retryable !== true)
      ) {
        return [`pending error is invalid for ${snapshot.id}`];
      }
      continue;
    }
    if (grading.status === 'unavailable') {
      if (value.phase === 'reviewed')
        return ['reviewed payload cannot contain unavailable grading'];
      if (
        !isRecord(grading.error) ||
        typeof grading.error.code !== 'string' ||
        grading.error.retryable !== false
      ) {
        return [`unavailable error is invalid for ${snapshot.id}`];
      }
      continue;
    }
    if (
      grading.status !== 'graded' ||
      !isQuestionResult(grading.result, snapshot.id, snapshot.points) ||
      !isProvenance(grading.provenance)
    ) {
      return [`graded fact is invalid for ${snapshot.id}`];
    }
    gradedResults.push(grading.result);
    provenanceProjection[snapshot.id] = grading.provenance;
  }

  if (JSON.stringify(value.results) !== JSON.stringify(gradedResults)) {
    return ['results must project graded facts only'];
  }
  if (JSON.stringify(value.gradeProvenance) !== JSON.stringify(provenanceProjection)) {
    return ['gradeProvenance must project graded facts only'];
  }
  return [];
}

export function isQuizAttemptPayloadV2(value: unknown): value is QuizAttemptPayloadV2 {
  return validateQuizAttemptPayloadV2(value).length === 0;
}
