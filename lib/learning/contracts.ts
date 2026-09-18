import type { RuntimePayloadValidator } from '@openmaic/storage';
import type { SceneType } from '@/lib/types/stage';

export const LEARNING_SNAPSHOT_ALGORITHM_VERSION = 'learning-content-v1' as const;
export const LEARNING_SCORING_VERSION = 'learning-scoring-v1' as const;
export const LEARNING_PROMPT_VERSION = 'learning-check-prompt-v1' as const;
export const LEARNING_SCHEMA_VERSION = 'learning-check-schema-v1' as const;

export const LEARNING_CHECK_LIMITS = Object.freeze({
  requestBytes: 128 * 1024,
  evidenceCharacters: 24_000,
  evidenceFragments: 30,
  fragmentCharacters: 2_000,
  questionCharacters: 2_000,
  explanationCharacters: 2_000,
  answerCharacters: 4_000,
  maxQuestions: 5,
  maxShortAnswers: 2,
  maxOutputTokens: 4_000,
  maxModelCalls: 2,
  timeoutMs: 90_000,
});

export type LearningCheckSource = 'course_check' | 'remediation_check';
export type LearningCheckPhase = 'draft' | 'submitted' | 'reviewed';

export interface LearningSourceRef {
  sceneId: string;
  sceneType: SceneType;
  sceneTitle: string;
}

export interface LearningEvidenceFragment {
  id: string;
  sourceRef: LearningSourceRef;
  text: string;
  digest: string;
}

export interface LearningContentSnapshot {
  snapshotAlgorithmVersion: typeof LEARNING_SNAPSHOT_ALGORITHM_VERSION;
  contentRevision: string;
  courseTitle: string;
  fragments: LearningEvidenceFragment[];
  coverage: {
    includedSceneIds: string[];
    limitedSceneIds: string[];
    notes: string[];
  };
}

export interface LearningQuestionOption {
  label: string;
  value: string;
}

export interface LearningQuestion {
  id: string;
  type: 'single' | 'multiple' | 'short_answer';
  prompt: string;
  options?: LearningQuestionOption[];
  correctAnswer?: string[];
  scoringGuide: string;
  explanation: string;
  maxScore: number;
  conceptId: string;
  sourceRefs: string[];
}

export interface LearningQuestionSet {
  questionSetId: string;
  scoringVersion: typeof LEARNING_SCORING_VERSION;
  questions: LearningQuestion[];
  coverageNote: string;
}

export type LearningAnswer = string | string[];

export type LearningQuestionGrade =
  | { status: 'pending' }
  | { status: 'error'; message: string }
  | { status: 'graded'; score: number; comment: string; basis: 'deterministic' | 'model' };

export interface LearningCheckPayloadV1 {
  payloadVersion: 1;
  identity: {
    checkId: string;
    attemptId: string;
    source: LearningCheckSource;
    requestId: string;
    parentAttemptId?: string;
    questionId?: string;
  };
  source: LearningContentSnapshot;
  questionSet: LearningQuestionSet;
  lifecycle: {
    phase: LearningCheckPhase;
    answers: Record<string, LearningAnswer>;
    grading: Record<string, LearningQuestionGrade>;
    startedAt: string;
    submittedAt?: string;
    reviewedAt?: string;
  };
  generation: {
    promptVersion: typeof LEARNING_PROMPT_VERSION;
    schemaVersion: typeof LEARNING_SCHEMA_VERSION;
    model: string;
    calls: number;
    usage: 'unknown' | { inputTokens?: number; outputTokens?: number; totalTokens?: number };
    review: { status: 'passed'; notes: string[] };
  };
}

export interface LearningCheckResponse {
  questionSet: LearningQuestionSet;
  coverage: LearningContentSnapshot['coverage'];
  review: { status: 'passed'; notes: string[] };
  generation: LearningCheckPayloadV1['generation'];
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function nonEmpty(value: unknown, max = Number.POSITIVE_INFINITY): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function validQuestion(question: unknown): question is LearningQuestion {
  if (!object(question)) return false;
  if (
    !nonEmpty(question.id) ||
    !nonEmpty(question.prompt, LEARNING_CHECK_LIMITS.questionCharacters)
  ) {
    return false;
  }
  if (!['single', 'multiple', 'short_answer'].includes(String(question.type))) return false;
  if (!nonEmpty(question.scoringGuide, LEARNING_CHECK_LIMITS.explanationCharacters)) return false;
  if (!nonEmpty(question.explanation, LEARNING_CHECK_LIMITS.explanationCharacters)) return false;
  if (!Number.isInteger(question.maxScore) || Number(question.maxScore) <= 0) return false;
  if (
    !nonEmpty(question.conceptId) ||
    !Array.isArray(question.sourceRefs) ||
    question.sourceRefs.length === 0
  ) {
    return false;
  }
  if (!question.sourceRefs.every((ref) => nonEmpty(ref))) return false;
  if (question.type === 'short_answer') return question.options === undefined;
  if (!Array.isArray(question.options) || question.options.length < 2) return false;
  if (
    !question.options.every(
      (option) => object(option) && nonEmpty(option.label) && nonEmpty(option.value),
    )
  ) {
    return false;
  }
  const optionValues = question.options.map((option) => option.value);
  if (new Set(optionValues).size !== optionValues.length) return false;
  if (!Array.isArray(question.correctAnswer) || question.correctAnswer.length === 0) return false;
  if (new Set(question.correctAnswer).size !== question.correctAnswer.length) return false;
  if (!question.correctAnswer.every((answer) => optionValues.includes(answer))) return false;
  return question.type !== 'single' || question.correctAnswer.length === 1;
}

export function validateLearningQuestionSet(
  value: unknown,
  source: LearningCheckSource = 'course_check',
): value is LearningQuestionSet {
  if (!object(value) || !nonEmpty(value.questionSetId)) return false;
  if (value.scoringVersion !== LEARNING_SCORING_VERSION || !nonEmpty(value.coverageNote, 2_000)) {
    return false;
  }
  if (!Array.isArray(value.questions)) return false;
  const expectedCount = source === 'remediation_check' ? 1 : undefined;
  if (
    value.questions.length === 0 ||
    value.questions.length > LEARNING_CHECK_LIMITS.maxQuestions ||
    (expectedCount !== undefined && value.questions.length !== expectedCount) ||
    !value.questions.every(validQuestion)
  ) {
    return false;
  }
  const questionIds = value.questions.map((question) => question.id);
  if (new Set(questionIds).size !== questionIds.length) return false;
  return value.questions.filter((question) => question.type === 'short_answer').length <= 2;
}

export function isLearningCheckPayloadV1(value: unknown): value is LearningCheckPayloadV1 {
  if (!object(value) || value.payloadVersion !== 1) return false;
  const identity = value.identity;
  const source = value.source;
  const lifecycle = value.lifecycle;
  const generation = value.generation;
  if (!object(identity) || !object(source) || !object(lifecycle) || !object(generation))
    return false;
  if (
    !hasOnlyKeys(identity, [
      'checkId',
      'attemptId',
      'source',
      'requestId',
      'parentAttemptId',
      'questionId',
    ]) ||
    !nonEmpty(identity.checkId) ||
    !nonEmpty(identity.attemptId) ||
    !nonEmpty(identity.requestId) ||
    (identity.source !== 'course_check' && identity.source !== 'remediation_check')
  ) {
    return false;
  }
  const hasParentAttemptId = Object.prototype.hasOwnProperty.call(identity, 'parentAttemptId');
  const hasQuestionId = Object.prototype.hasOwnProperty.call(identity, 'questionId');
  if (
    identity.source === 'remediation_check'
      ? !hasParentAttemptId ||
        !hasQuestionId ||
        !nonEmpty(identity.parentAttemptId) ||
        !nonEmpty(identity.questionId)
      : hasParentAttemptId || hasQuestionId
  ) {
    return false;
  }
  if (
    source.snapshotAlgorithmVersion !== LEARNING_SNAPSHOT_ALGORITHM_VERSION ||
    !nonEmpty(source.contentRevision) ||
    !/^sha256:[a-f0-9]{64}$/.test(source.contentRevision) ||
    !nonEmpty(source.courseTitle) ||
    !Array.isArray(source.fragments) ||
    source.fragments.length === 0 ||
    source.fragments.length > LEARNING_CHECK_LIMITS.evidenceFragments ||
    !object(source.coverage)
  ) {
    return false;
  }
  if (!validateLearningQuestionSet(value.questionSet, identity.source)) return false;
  if (!['draft', 'submitted', 'reviewed'].includes(String(lifecycle.phase))) return false;
  if (!object(lifecycle.answers) || !object(lifecycle.grading) || !nonEmpty(lifecycle.startedAt)) {
    return false;
  }
  let evidenceCharacters = 0;
  const fragmentIds = new Set<string>();
  for (const fragment of source.fragments) {
    if (!object(fragment) || !object(fragment.sourceRef)) return false;
    if (
      !nonEmpty(fragment.id) ||
      fragmentIds.has(fragment.id) ||
      !nonEmpty(fragment.text, LEARNING_CHECK_LIMITS.fragmentCharacters) ||
      !nonEmpty(fragment.digest) ||
      !/^sha256:[a-f0-9]{64}$/.test(fragment.digest) ||
      !nonEmpty(fragment.sourceRef.sceneId) ||
      !nonEmpty(fragment.sourceRef.sceneTitle) ||
      !['slide', 'quiz', 'interactive', 'pbl'].includes(String(fragment.sourceRef.sceneType))
    ) {
      return false;
    }
    fragmentIds.add(fragment.id);
    evidenceCharacters += fragment.text.length;
  }
  if (evidenceCharacters > LEARNING_CHECK_LIMITS.evidenceCharacters) return false;
  const questionSet = value.questionSet as LearningQuestionSet;
  const questions = new Map(questionSet.questions.map((question) => [question.id, question]));
  if (
    questionSet.questions.some((question) =>
      question.sourceRefs.some((sourceRef) => !fragmentIds.has(sourceRef)),
    )
  ) {
    return false;
  }
  for (const [questionId, answer] of Object.entries(lifecycle.answers)) {
    if (!questions.has(questionId)) return false;
    if (typeof answer === 'string') {
      if (answer.length > LEARNING_CHECK_LIMITS.answerCharacters) return false;
    } else if (!Array.isArray(answer) || !answer.every((member) => nonEmpty(member, 256))) {
      return false;
    }
  }
  for (const [questionId, grade] of Object.entries(lifecycle.grading)) {
    const question = questions.get(questionId);
    if (!question || !object(grade)) return false;
    if (grade.status === 'pending') continue;
    if (grade.status === 'error') {
      if (!nonEmpty(grade.message, 1_000)) return false;
      continue;
    }
    if (
      grade.status !== 'graded' ||
      !Number.isInteger(grade.score) ||
      Number(grade.score) < 0 ||
      Number(grade.score) > question.maxScore ||
      !nonEmpty(grade.comment, 2_000) ||
      (grade.basis !== 'deterministic' && grade.basis !== 'model')
    ) {
      return false;
    }
  }
  if (
    lifecycle.phase === 'reviewed' &&
    questionSet.questions.some(
      (question) =>
        (lifecycle.grading as Record<string, LearningQuestionGrade>)[question.id]?.status !==
        'graded',
    )
  ) {
    return false;
  }
  if (
    (lifecycle.phase === 'submitted' || lifecycle.phase === 'reviewed') &&
    !nonEmpty(lifecycle.submittedAt)
  ) {
    return false;
  }
  if (lifecycle.phase === 'reviewed' && !nonEmpty(lifecycle.reviewedAt)) return false;
  if (
    generation.promptVersion !== LEARNING_PROMPT_VERSION ||
    generation.schemaVersion !== LEARNING_SCHEMA_VERSION ||
    !nonEmpty(generation.model) ||
    !Number.isInteger(generation.calls) ||
    Number(generation.calls) < 1 ||
    Number(generation.calls) > LEARNING_CHECK_LIMITS.maxModelCalls ||
    !object(generation.review) ||
    generation.review.status !== 'passed'
  ) {
    return false;
  }
  return true;
}

export const learningCheckRuntimePayloadValidator: RuntimePayloadValidator = (payload) =>
  isLearningCheckPayloadV1(payload)
    ? { valid: true }
    : {
        valid: false,
        errors: [{ path: '/payload', message: 'learningCheck payload must match version 1' }],
      };
