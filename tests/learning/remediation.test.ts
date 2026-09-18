import { describe, expect, it } from 'vitest';

import {
  buildLearningRemediationContext,
  buildQuizPayloadRemediationContext,
  buildQuizRemediationContext,
  createRemediationCheckPlan,
  materializeRemediationCheckDraft,
  remediationToGuidedLearningContext,
  resolveRemediationReviewTarget,
} from '@/lib/learning/remediation';
import { parseGuidedLearningContext } from '@/lib/learning/guided-contracts';
import type { QuizAttemptState } from '@/lib/quiz/runtime';
import { learningPayload } from './fixtures';

describe('learning remediation context', () => {
  it('projects one frozen learning attempt question and only its allowlisted evidence', () => {
    const payload = learningPayload('reviewed');
    payload.lifecycle.answers.q1 = ['B'];
    payload.lifecycle.grading.q1 = {
      status: 'graded',
      score: 0,
      comment: 'Color is not changed by net force.',
      basis: 'deterministic',
    };
    payload.source.fragments.push({
      id: 'scene:unrelated',
      sourceRef: { sceneId: 'unrelated', sceneType: 'slide', sceneTitle: 'Unrelated' },
      text: 'This fragment was not cited by the question.',
      digest: `sha256:${'c'.repeat(64)}`,
    });

    const context = buildLearningRemediationContext(payload, 'q1');

    expect(context).toMatchObject({
      schemaVersion: 1,
      source: {
        kind: 'learning_attempt',
        attemptId: 'attempt-1',
        questionId: 'q1',
        contentRevision: `sha256:${'a'.repeat(64)}`,
      },
      conceptId: 'force',
      question: {
        prompt: 'What does net force change?',
        answer: ['B'],
        grading: {
          status: 'graded',
          score: 0,
          maxScore: 2,
          comment: 'Color is not changed by net force.',
          basis: 'deterministic',
          interpretation: 'needs_review',
        },
      },
    });
    expect(context.sourceRefs).toEqual([
      {
        ref: 'scene:scene-1',
        sceneId: 'scene-1',
        digest: `sha256:${'b'.repeat(64)}`,
        content: 'Net force changes motion.',
      },
    ]);
  });

  it('does not retain mutable answer arrays from the runtime payload', () => {
    const payload = learningPayload('reviewed');
    const context = buildLearningRemediationContext(payload, 'q1');

    (payload.lifecycle.answers.q1 as string[]).push('B');

    expect(context.question.answer).toEqual(['A']);
  });

  it('falls back to historical question evidence when the content version no longer matches', () => {
    const payload = learningPayload('submitted');
    payload.lifecycle.grading.q1 = { status: 'pending' };
    const context = buildLearningRemediationContext(payload, 'q1');

    expect(context.question.grading).toEqual({
      status: 'pending',
      interpretation: 'needs_verification',
    });
    expect(
      resolveRemediationReviewTarget(context, {
        currentContentRevision: `sha256:${'d'.repeat(64)}`,
        availableSceneIds: new Set(['scene-1']),
      }),
    ).toEqual({ kind: 'historical_only', label: 'original_question' });
  });

  it('uses only a frozen v2 quiz snapshot and treats unavailable grading as unverified', () => {
    const attempt: QuizAttemptState = {
      sessionId: 'quiz-attempt-1',
      status: 'completed',
      payloadVersion: 2,
      phase: 'reviewed',
      contentRevision: 'quiz-snapshot-v1:deadbeef',
      answers: { q1: 'student response' },
      questionSnapshot: [
        {
          id: 'q1',
          type: 'short_answer',
          question: 'Explain inertia in your own words.',
          analysis: 'A correct answer connects inertia to resistance to motion changes.',
          points: 3,
        },
      ],
      grading: {
        q1: {
          status: 'unavailable',
          error: { code: 'MISSING_GRADING_BASIS', retryable: false },
        },
      },
      gradeProvenance: {},
      results: [],
    };

    const context = buildQuizRemediationContext(attempt, 'q1', 'quiz-scene');

    expect(context.question).toMatchObject({
      prompt: 'Explain inertia in your own words.',
      answer: 'student response',
      grading: {
        status: 'unavailable',
        reason: 'MISSING_GRADING_BASIS',
        interpretation: 'needs_verification',
      },
    });
    expect(context.sourceRefs).toEqual([]);
    expect(
      resolveRemediationReviewTarget(context, {
        currentContentRevision: 'quiz-snapshot-v1:deadbeef',
        availableSceneIds: new Set(['quiz-scene']),
      }),
    ).toEqual({ kind: 'scene', sceneId: 'quiz-scene', label: 'original_question' });
  });

  it('builds the QuizView remediation context directly from its frozen reviewed payload', () => {
    const context = buildQuizPayloadRemediationContext(
      {
        payloadVersion: 2,
        phase: 'reviewed',
        contentRevision: 'quiz-snapshot-v1:feedbeef',
        answers: { q1: 'B' },
        questionSnapshot: [
          {
            id: 'q1',
            type: 'single',
            question: 'Which answer is correct?',
            options: [
              { value: 'A', label: 'A' },
              { value: 'B', label: 'B' },
            ],
            answer: ['A'],
            analysis: 'A is correct.',
            points: 2,
          },
        ],
        grading: {
          q1: {
            status: 'graded',
            result: { questionId: 'q1', correct: false, status: 'incorrect', earned: 0 },
            provenance: {
              ruleVersion: 'quiz-grading-v1',
              basis: 'answer-key',
              gradedAt: '2026-09-14T00:00:00.000Z',
            },
          },
        },
        results: [{ questionId: 'q1', correct: false, status: 'incorrect', earned: 0 }],
        gradeProvenance: {
          q1: {
            ruleVersion: 'quiz-grading-v1',
            basis: 'answer-key',
            gradedAt: '2026-09-14T00:00:00.000Z',
          },
        },
      },
      'quiz-attempt-real',
      'q1',
      'quiz-scene',
    );

    expect(context).toMatchObject({
      source: { kind: 'quiz_attempt', attemptId: 'quiz-attempt-real', questionId: 'q1' },
      originalQuestionSceneId: 'quiz-scene',
      question: { answer: 'B', grading: { status: 'graded', interpretation: 'needs_review' } },
      sourceRefs: [],
    });
  });

  it('starts guided discussion with explicit frozen facts that survive scene changes', () => {
    const payload = learningPayload('reviewed');
    const context = buildLearningRemediationContext(payload, 'q1');

    const guided = remediationToGuidedLearningContext(context, {
      requestId: 'guided-request-1',
      chatSessionId: 'new-remediation-session',
      stageId: 'stage-1',
    });

    expect(parseGuidedLearningContext(guided)).toEqual(guided);
    expect(guided).toMatchObject({
      phase: 'explain',
      contentRevision: payload.source.contentRevision,
      scopedRevision: `${payload.source.contentRevision}:learning_attempt:attempt-1:q1`,
      source: { kind: 'learning_attempt', attemptId: 'attempt-1', questionId: 'q1' },
    });
    expect(guided.evidence.map((item) => item.ref)).toEqual([
      'remediation:learning_attempt:attempt-1:q1',
      'scene:scene-1',
    ]);
    expect(guided.evidence[0]?.content).toContain('"status":"graded"');
    expect(guided.evidence[1]?.content).toBe('Net force changes motion.');
  });

  it('plans one independent remediation check from verified concept evidence', () => {
    const payload = learningPayload('reviewed');
    const context = buildLearningRemediationContext(payload, 'q1');

    const plan = createRemediationCheckPlan(context, payload.source, {
      requestId: 'remediation-request-1',
      checkId: 'remediation-check-1',
      attemptId: 'remediation-attempt-1',
    });

    expect(plan.request).toMatchObject({
      requestId: 'remediation-request-1',
      scope: 'remediation',
      focus: {
        conceptId: 'force',
        priorQuestionPrompt: 'What does net force change?',
      },
    });
    expect(plan.request.snapshot.fragments.map((fragment) => fragment.id)).toEqual([
      'scene:scene-1',
    ]);
    expect(plan.identity).toEqual({
      checkId: 'remediation-check-1',
      attemptId: 'remediation-attempt-1',
      source: 'remediation_check',
      requestId: 'remediation-request-1',
      parentAttemptId: 'attempt-1',
      questionId: 'q1',
    });
  });

  it('materializes the generated check as a separate parent-linked draft without overwriting history', () => {
    const parent = learningPayload('reviewed');
    const context = buildLearningRemediationContext(parent, 'q1');
    const plan = createRemediationCheckPlan(context, parent.source, {
      requestId: 'remediation-request-1',
      checkId: 'remediation-check-1',
      attemptId: 'remediation-attempt-1',
    });
    const question = {
      ...parent.questionSet.questions[0]!,
      id: 'remediation-q1',
      prompt: 'Which change is caused by a net force?',
    };

    const draft = materializeRemediationCheckDraft(
      plan,
      {
        questionSet: {
          ...parent.questionSet,
          questionSetId: 'remediation-set-1',
          questions: [question],
        },
        coverage: plan.request.snapshot.coverage,
        review: { status: 'passed', notes: [] },
        generation: parent.generation,
      },
      () => '2026-09-14T02:00:00.000Z',
    );

    expect(draft.identity).toEqual(plan.identity);
    expect(draft.lifecycle).toEqual({
      phase: 'draft',
      answers: {},
      grading: {},
      startedAt: '2026-09-14T02:00:00.000Z',
    });
    expect(draft.questionSet.questions).toEqual([question]);
    expect(parent.lifecycle.phase).toBe('reviewed');
  });
});
