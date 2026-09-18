import { describe, expect, it } from 'vitest';

import { projectLearningFeedback } from '@/lib/learning/report';
import type { StoredLearningCheckAttempt } from '@/lib/learning/runtime';
import { learningPayload } from './fixtures';

function attempt(
  phase: 'draft' | 'submitted' | 'reviewed',
  patch?: (value: StoredLearningCheckAttempt) => void,
): StoredLearningCheckAttempt {
  const payload = learningPayload(phase);
  const value: StoredLearningCheckAttempt = {
    sessionId: payload.identity.attemptId,
    status: phase === 'reviewed' ? 'completed' : 'active',
    createdAt: '2026-09-14T00:00:00.000Z',
    updatedAt: '2026-09-14T00:02:00.000Z',
    lastSeq: phase === 'draft' ? 0 : phase === 'submitted' ? 1 : 2,
    payload,
  };
  patch?.(value);
  return value;
}

describe('projectLearningFeedback', () => {
  it('distinguishes no participation from a zero score', () => {
    expect(projectLearningFeedback([], `sha256:${'a'.repeat(64)}`)).toEqual({
      status: 'none',
      attempts: [],
      groups: [],
    });
  });

  it('reports a saved draft without inventing a score', () => {
    const report = projectLearningFeedback([attempt('draft')], `sha256:${'a'.repeat(64)}`);
    expect(report.status).toBe('draft');
    expect(report.attempts[0]).toMatchObject({
      status: 'draft',
      gradedCount: 0,
      pendingCount: 1,
      earnedPoints: 0,
      gradedPossiblePoints: 0,
      finalPercent: undefined,
    });
  });

  it('excludes pending questions from both the graded denominator and final percentage', () => {
    const value = attempt('reviewed', (entry) => {
      entry.payload.questionSet.questions.push({
        ...entry.payload.questionSet.questions[0]!,
        id: 'q2',
        type: 'short_answer',
        options: undefined,
        correctAnswer: undefined,
        maxScore: 3,
        conceptId: 'acceleration',
      });
      entry.payload.lifecycle.answers.q2 = 'It changes velocity.';
      entry.payload.lifecycle.grading.q2 = { status: 'pending' };
    });
    const report = projectLearningFeedback([value], value.payload.source.contentRevision);

    expect(report.status).toBe('partial');
    expect(report.attempts[0]).toMatchObject({
      gradedCount: 1,
      pendingCount: 1,
      earnedPoints: 2,
      gradedPossiblePoints: 2,
      fullPossiblePoints: 5,
      finalPercent: undefined,
    });
  });

  it('keeps content/question/scoring versions in separate groups and marks old content', () => {
    const old = attempt('reviewed');
    const current = attempt('reviewed', (entry) => {
      entry.sessionId = 'attempt-2';
      entry.payload.identity.attemptId = 'attempt-2';
      entry.payload.identity.checkId = 'check-2';
      entry.payload.source.contentRevision = `sha256:${'c'.repeat(64)}`;
      entry.payload.questionSet.questionSetId = 'question-set-2';
      entry.createdAt = '2026-09-14T01:00:00.000Z';
    });
    const report = projectLearningFeedback([old, current], current.payload.source.contentRevision);

    expect(report.status).toBe('complete');
    expect(report.groups).toHaveLength(2);
    expect(report.groups.map((group) => group.attemptIds)).toEqual([['attempt-1'], ['attempt-2']]);
    expect(report.attempts.map((entry) => entry.oldContentVersion)).toEqual([true, false]);
  });

  it('preserves remediation parent linkage and emits an i18n recommendation code', () => {
    const value = attempt('reviewed', (entry) => {
      entry.payload.identity.source = 'remediation_check';
      entry.payload.identity.parentAttemptId = 'parent-attempt';
      entry.payload.identity.questionId = 'parent-question';
      entry.payload.lifecycle.grading.q1 = {
        status: 'graded',
        score: 0,
        comment: 'Needs another try.',
        basis: 'model',
      };
    });

    const report = projectLearningFeedback([value], value.payload.source.contentRevision);

    expect(report.attempts[0]).toMatchObject({
      source: 'remediation_check',
      parentAttemptId: 'parent-attempt',
      parentQuestionId: 'parent-question',
      questions: [{ recommendation: 'review_source_and_retry' }],
    });
  });
});
