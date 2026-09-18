import { validateLearningQuestionSet } from '@/lib/learning/contracts';
import type {
  LearningAnswer,
  LearningCheckPayloadV1,
  LearningCheckResponse,
  LearningContentSnapshot,
  LearningQuestionGrade,
} from '@/lib/learning/contracts';
import type { GuidedLearningContext } from '@/lib/learning/guided-contracts';
import type { QuizAttemptPayloadV2, QuizQuestionGrading } from '@/lib/quiz/attempt-schema';
import type { QuizAttemptState } from '@/lib/quiz/runtime';

export const REMEDIATION_CONTEXT_VERSION = 1 as const;

export interface RemediationSourceRef {
  ref: string;
  sceneId: string;
  digest: string;
  content: string;
}

export type RemediationGrading =
  | { status: 'pending'; interpretation: 'needs_verification' }
  | { status: 'unavailable'; reason: string; interpretation: 'needs_verification' }
  | {
      status: 'graded';
      score: number;
      maxScore: number;
      comment: string;
      basis: string;
      interpretation: 'needs_review' | 'verified';
    };

export interface RemediationContext {
  schemaVersion: typeof REMEDIATION_CONTEXT_VERSION;
  source: {
    kind: 'learning_attempt' | 'quiz_attempt';
    attemptId: string;
    questionId: string;
    contentRevision: string;
  };
  conceptId?: string;
  originalQuestionSceneId?: string;
  question: {
    prompt: string;
    answer?: LearningAnswer;
    explanation?: string;
    scoringGuide?: string;
    grading: RemediationGrading;
  };
  sourceRefs: RemediationSourceRef[];
}

export interface RemediationCheckPlan {
  request: {
    requestId: string;
    scope: 'remediation';
    snapshot: LearningContentSnapshot;
    focus: { conceptId: string; priorQuestionPrompt: string };
  };
  identity: LearningCheckPayloadV1['identity'];
}

function cloneAnswer(answer: LearningAnswer): LearningAnswer {
  return Array.isArray(answer) ? [...answer] : answer;
}

function quizGrading(grade: QuizQuestionGrading | undefined, maxScore: number): RemediationGrading {
  if (!grade || grade.status === 'pending') {
    return { status: 'pending', interpretation: 'needs_verification' };
  }
  if (grade.status === 'unavailable') {
    return {
      status: 'unavailable',
      reason: grade.error.code,
      interpretation: 'needs_verification',
    };
  }
  return {
    status: 'graded',
    score: grade.result.earned,
    maxScore,
    comment: grade.result.aiComment ?? '',
    basis: grade.provenance.basis,
    interpretation: grade.result.earned < maxScore ? 'needs_review' : 'verified',
  };
}

export type RemediationReviewTarget =
  | { kind: 'scene'; sceneId: string; label: 'explanation' | 'original_question' }
  | { kind: 'historical_only'; label: 'original_question' };

function learningGrading(
  grade: LearningQuestionGrade | undefined,
  maxScore: number,
): RemediationGrading {
  if (!grade || grade.status === 'pending') {
    return { status: 'pending', interpretation: 'needs_verification' };
  }
  if (grade.status === 'error') {
    return {
      status: 'unavailable',
      reason: grade.message,
      interpretation: 'needs_verification',
    };
  }
  return {
    status: 'graded',
    score: grade.score,
    maxScore,
    comment: grade.comment,
    basis: grade.basis,
    interpretation: grade.score < maxScore ? 'needs_review' : 'verified',
  };
}

/** Project one immutable learning-check fact into the bounded remediation context. */
export function buildLearningRemediationContext(
  payload: LearningCheckPayloadV1,
  questionId: string,
): RemediationContext {
  const question = payload.questionSet.questions.find((candidate) => candidate.id === questionId);
  if (!question) throw new Error(`Unknown learning-check question ${JSON.stringify(questionId)}`);
  const allowedRefs = new Set(question.sourceRefs);
  return {
    schemaVersion: REMEDIATION_CONTEXT_VERSION,
    source: {
      kind: 'learning_attempt',
      attemptId: payload.identity.attemptId,
      questionId,
      contentRevision: payload.source.contentRevision,
    },
    conceptId: question.conceptId,
    question: {
      prompt: question.prompt,
      ...(payload.lifecycle.answers[questionId] === undefined
        ? {}
        : { answer: cloneAnswer(payload.lifecycle.answers[questionId]) }),
      explanation: question.explanation,
      scoringGuide: question.scoringGuide,
      grading: learningGrading(payload.lifecycle.grading[questionId], question.maxScore),
    },
    sourceRefs: payload.source.fragments
      .filter((fragment) => allowedRefs.has(fragment.id))
      .map((fragment) => ({
        ref: fragment.id,
        sceneId: fragment.sourceRef.sceneId,
        digest: fragment.digest,
        content: fragment.text,
      })),
  };
}

/** Build from v2 evidence only; legacy quiz state must never recreate historical questions. */
export function buildQuizRemediationContext(
  attempt: QuizAttemptState,
  questionId: string,
  sceneId: string,
): RemediationContext {
  if (
    attempt.payloadVersion !== 2 ||
    !attempt.questionSnapshot ||
    !attempt.contentRevision ||
    !attempt.grading
  ) {
    throw new Error('Quiz remediation requires an immutable v2 attempt snapshot');
  }
  return buildQuizPayloadRemediationContext(
    {
      payloadVersion: 2,
      phase: attempt.phase,
      questionSnapshot: attempt.questionSnapshot,
      contentRevision: attempt.contentRevision,
      answers: attempt.answers,
      grading: attempt.grading,
      results: attempt.results ?? [],
      gradeProvenance: attempt.gradeProvenance ?? {},
      ...(attempt.submittedDigest ? { submittedDigest: attempt.submittedDigest } : {}),
      ...(attempt.archived === undefined ? {} : { archived: attempt.archived }),
    },
    attempt.sessionId,
    questionId,
    sceneId,
  );
}

export function buildQuizPayloadRemediationContext(
  attempt: QuizAttemptPayloadV2,
  attemptId: string,
  questionId: string,
  sceneId: string,
): RemediationContext {
  const question = attempt.questionSnapshot.find((candidate) => candidate.id === questionId);
  if (!question) throw new Error(`Unknown quiz question ${JSON.stringify(questionId)}`);
  return {
    schemaVersion: REMEDIATION_CONTEXT_VERSION,
    source: {
      kind: 'quiz_attempt',
      attemptId,
      questionId,
      contentRevision: attempt.contentRevision,
    },
    originalQuestionSceneId: sceneId,
    question: {
      prompt: question.question,
      ...(attempt.answers[questionId] === undefined
        ? {}
        : { answer: cloneAnswer(attempt.answers[questionId]) }),
      ...(question.analysis === undefined ? {} : { explanation: question.analysis }),
      ...(question.commentPrompt === undefined ? {} : { scoringGuide: question.commentPrompt }),
      grading: quizGrading(attempt.grading[questionId], question.points),
    },
    // Existing quiz snapshots have no verified concept/source-fragment mapping.
    sourceRefs: [],
  };
}

/** Resolve a navigation intent; callers must execute it through gatedSceneSwitch. */
export function resolveRemediationReviewTarget(
  context: RemediationContext,
  current: { currentContentRevision: string; availableSceneIds: ReadonlySet<string> },
): RemediationReviewTarget {
  if (context.source.contentRevision !== current.currentContentRevision) {
    return { kind: 'historical_only', label: 'original_question' };
  }
  const source = context.sourceRefs.find((candidate) =>
    current.availableSceneIds.has(candidate.sceneId),
  );
  if (source) return { kind: 'scene', sceneId: source.sceneId, label: 'explanation' };
  if (
    context.originalQuestionSceneId &&
    current.availableSceneIds.has(context.originalQuestionSceneId)
  ) {
    return {
      kind: 'scene',
      sceneId: context.originalQuestionSceneId,
      label: 'original_question',
    };
  }
  return { kind: 'historical_only', label: 'original_question' };
}

/** Adapt immutable remediation facts to the public guided-session seam. */
export function remediationToGuidedLearningContext(
  context: RemediationContext,
  session: { requestId: string; chatSessionId: string; stageId: string },
): GuidedLearningContext {
  const contextRef = [
    'remediation',
    context.source.kind,
    context.source.attemptId,
    context.source.questionId,
  ].join(':');
  const evidence = [
    { ref: contextRef, content: JSON.stringify(context.question) },
    ...context.sourceRefs.map((sourceRef) => ({
      ref: sourceRef.ref,
      content: sourceRef.content,
    })),
  ];
  return {
    schemaVersion: 1,
    requestId: session.requestId,
    chatSessionId: session.chatSessionId,
    stageId: session.stageId,
    contentRevision: context.source.contentRevision,
    scopedRevision: [
      context.source.contentRevision,
      context.source.kind,
      context.source.attemptId,
      context.source.questionId,
    ].join(':'),
    phase: 'explain',
    source: {
      kind: context.source.kind,
      attemptId: context.source.attemptId,
      questionId: context.source.questionId,
    },
    evidence: evidence.slice(0, 12),
  };
}

/** Plan, but do not answer, a distinct one-question remediation attempt. */
export function createRemediationCheckPlan(
  context: RemediationContext,
  evidencePackage: LearningContentSnapshot,
  ids: { requestId: string; checkId: string; attemptId: string },
): RemediationCheckPlan {
  if (!context.conceptId) {
    throw new Error('A remediation check requires a verified concept mapping');
  }
  if (evidencePackage.contentRevision !== context.source.contentRevision) {
    throw new Error('Remediation evidence no longer matches the source attempt');
  }
  const allowed = new Map(
    context.sourceRefs.map((sourceRef) => [
      sourceRef.ref,
      `${sourceRef.sceneId}\u0000${sourceRef.digest}`,
    ]),
  );
  const fragments = evidencePackage.fragments.filter(
    (fragment) =>
      allowed.get(fragment.id) === `${fragment.sourceRef.sceneId}\u0000${fragment.digest}`,
  );
  if (fragments.length === 0) {
    throw new Error('A remediation check requires verified source evidence');
  }
  const includedSceneIds = [...new Set(fragments.map((fragment) => fragment.sourceRef.sceneId))];
  return {
    request: {
      requestId: ids.requestId,
      scope: 'remediation',
      snapshot: {
        ...evidencePackage,
        fragments,
        coverage: {
          includedSceneIds,
          limitedSceneIds: evidencePackage.coverage.limitedSceneIds.filter((sceneId) =>
            includedSceneIds.includes(sceneId),
          ),
          notes: [...evidencePackage.coverage.notes],
        },
      },
      focus: {
        conceptId: context.conceptId,
        priorQuestionPrompt: context.question.prompt,
      },
    },
    identity: {
      checkId: ids.checkId,
      attemptId: ids.attemptId,
      source: 'remediation_check',
      requestId: ids.requestId,
      parentAttemptId: context.source.attemptId,
      questionId: context.source.questionId,
    },
  };
}

/** Freeze the reviewed one-question response as a new parent-linked attempt. */
export function materializeRemediationCheckDraft(
  plan: RemediationCheckPlan,
  response: LearningCheckResponse,
  now: () => string = () => new Date().toISOString(),
): LearningCheckPayloadV1 {
  if (!validateLearningQuestionSet(response.questionSet, 'remediation_check')) {
    throw new Error('Invalid remediation question set');
  }
  const question = response.questionSet.questions[0]!;
  if (
    question.conceptId !== plan.request.focus.conceptId ||
    question.prompt.trim().toLocaleLowerCase() ===
      plan.request.focus.priorQuestionPrompt.trim().toLocaleLowerCase()
  ) {
    throw new Error('Remediation check must use the same concept with a different question');
  }
  const fragmentIds = new Set(plan.request.snapshot.fragments.map((fragment) => fragment.id));
  if (!question.sourceRefs.every((sourceRef) => fragmentIds.has(sourceRef))) {
    throw new Error('Remediation check cited evidence outside the frozen package');
  }
  return {
    payloadVersion: 1,
    identity: { ...plan.identity },
    source: plan.request.snapshot,
    questionSet: response.questionSet,
    lifecycle: {
      phase: 'draft',
      answers: {},
      grading: {},
      startedAt: now(),
    },
    generation: response.generation,
  };
}
