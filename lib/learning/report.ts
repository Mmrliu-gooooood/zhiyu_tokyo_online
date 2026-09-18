import type { LearningAnswer, LearningQuestionGrade } from './contracts';
import type { StoredLearningCheckAttempt } from './runtime';

export type LearningFeedbackStatus = 'none' | 'draft' | 'partial' | 'complete';
export type LearningRecommendationCode = 'review_source_and_retry';

export interface LearningQuestionFeedback {
  questionId: string;
  prompt: string;
  studentAnswer?: LearningAnswer;
  grade: LearningQuestionGrade;
  maxScore: number;
  scoringGuide: string;
  explanation: string;
  conceptId: string;
  sourceRefs: string[];
  needsReview: boolean;
  recommendation?: LearningRecommendationCode;
}

export interface LearningAttemptFeedback {
  attemptId: string;
  checkId: string;
  source: StoredLearningCheckAttempt['payload']['identity']['source'];
  parentAttemptId?: string;
  parentQuestionId?: string;
  status: Exclude<LearningFeedbackStatus, 'none'>;
  contentRevision: string;
  questionSetId: string;
  scoringVersion: string;
  oldContentVersion: boolean;
  createdAt: string;
  updatedAt: string;
  gradedCount: number;
  pendingCount: number;
  earnedPoints: number;
  gradedPossiblePoints: number;
  fullPossiblePoints: number;
  finalPercent?: number;
  questions: LearningQuestionFeedback[];
}

export interface LearningFeedbackGroup {
  key: string;
  contentRevision: string;
  questionSetId: string;
  scoringVersion: string;
  attemptIds: string[];
}

export type LearningFeedbackReport =
  | { status: 'none'; attempts: []; groups: [] }
  | {
      status: Exclude<LearningFeedbackStatus, 'none'>;
      attempts: LearningAttemptFeedback[];
      groups: LearningFeedbackGroup[];
    };

function projectAttempt(
  attempt: StoredLearningCheckAttempt,
  currentContentRevision: string,
): LearningAttemptFeedback {
  const payload = attempt.payload;
  let gradedCount = 0;
  let earnedPoints = 0;
  let gradedPossiblePoints = 0;
  const questions = payload.questionSet.questions.map((question): LearningQuestionFeedback => {
    const grade = payload.lifecycle.grading[question.id] ?? { status: 'pending' as const };
    const isGraded = grade.status === 'graded';
    if (isGraded) {
      gradedCount += 1;
      earnedPoints += grade.score;
      gradedPossiblePoints += question.maxScore;
    }
    const needsReview = isGraded && grade.score < question.maxScore;
    return {
      questionId: question.id,
      prompt: question.prompt,
      ...(payload.lifecycle.answers[question.id] === undefined
        ? {}
        : { studentAnswer: payload.lifecycle.answers[question.id] }),
      grade,
      maxScore: question.maxScore,
      scoringGuide: question.scoringGuide,
      explanation: question.explanation,
      conceptId: question.conceptId,
      sourceRefs: question.sourceRefs,
      needsReview,
      ...(needsReview
        ? {
            recommendation: 'review_source_and_retry',
          }
        : {}),
    };
  });
  const fullPossiblePoints = payload.questionSet.questions.reduce(
    (total, question) => total + question.maxScore,
    0,
  );
  const pendingCount = questions.length - gradedCount;
  const status: LearningAttemptFeedback['status'] =
    payload.lifecycle.phase === 'draft'
      ? 'draft'
      : payload.lifecycle.phase === 'reviewed' && pendingCount === 0
        ? 'complete'
        : 'partial';
  return {
    attemptId: payload.identity.attemptId,
    checkId: payload.identity.checkId,
    source: payload.identity.source,
    ...(payload.identity.parentAttemptId
      ? { parentAttemptId: payload.identity.parentAttemptId }
      : {}),
    ...(payload.identity.questionId ? { parentQuestionId: payload.identity.questionId } : {}),
    status,
    contentRevision: payload.source.contentRevision,
    questionSetId: payload.questionSet.questionSetId,
    scoringVersion: payload.questionSet.scoringVersion,
    oldContentVersion: payload.source.contentRevision !== currentContentRevision,
    createdAt: attempt.createdAt,
    updatedAt: attempt.updatedAt,
    gradedCount,
    pendingCount,
    earnedPoints,
    gradedPossiblePoints,
    fullPossiblePoints,
    ...(status === 'complete'
      ? {
          finalPercent:
            fullPossiblePoints === 0 ? 0 : Math.round((earnedPoints / fullPossiblePoints) * 100),
        }
      : { finalPercent: undefined }),
    questions,
  };
}

export function projectLearningFeedback(
  storedAttempts: readonly StoredLearningCheckAttempt[],
  currentContentRevision: string,
): LearningFeedbackReport {
  if (storedAttempts.length === 0) return { status: 'none', attempts: [], groups: [] };
  const attempts = [...storedAttempts]
    .sort(
      (left, right) =>
        Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
        left.sessionId.localeCompare(right.sessionId),
    )
    .map((attempt) => projectAttempt(attempt, currentContentRevision));
  const groupsByKey = new Map<string, LearningFeedbackGroup>();
  for (const attempt of attempts) {
    const key = [attempt.contentRevision, attempt.questionSetId, attempt.scoringVersion].join('|');
    const group = groupsByKey.get(key);
    if (group) {
      group.attemptIds.push(attempt.attemptId);
    } else {
      groupsByKey.set(key, {
        key,
        contentRevision: attempt.contentRevision,
        questionSetId: attempt.questionSetId,
        scoringVersion: attempt.scoringVersion,
        attemptIds: [attempt.attemptId],
      });
    }
  }
  return { status: attempts.at(-1)!.status, attempts, groups: [...groupsByKey.values()] };
}
