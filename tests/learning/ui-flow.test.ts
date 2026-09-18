import { describe, expect, it, vi } from 'vitest';

import {
  gradeLearningSelection,
  gradeSubmittedLearningCheck,
} from '@/components/learning/LearningCheckForm';
import {
  generateAndPersistLearningCheck,
  generateAndPersistRemediationCheck,
  selectResumableLearningCheck,
  validateLearningSnapshotBeforePersist,
} from '@/components/learning/LearningFeedbackDialog';
import type { LearningCheckPayloadV1 } from '@/lib/learning/contracts';
import { buildLearningRemediationContext } from '@/lib/learning/remediation';
import type { StoredLearningCheckAttempt } from '@/lib/learning/runtime';
import { learningPayload } from './fixtures';

describe('learning-check UI flow', () => {
  it('rejects a same-stage edit whose content revision no longer matches the request', async () => {
    const payload = learningPayload();
    const scenes = [] as const;

    await expect(
      validateLearningSnapshotBeforePersist('stage-1', payload.source, {
        readCurrent: () => ({ stage: { id: 'stage-1', name: 'Physics' }, scenes }),
        buildSnapshot: async () => ({
          ...payload.source,
          contentRevision: `sha256:${'c'.repeat(64)}`,
        }),
      }),
    ).resolves.toBe(false);
  });

  it('grades selections deterministically without asking a model to answer for the learner', () => {
    const question = learningPayload().questionSet.questions[0]!;
    expect(gradeLearningSelection(question, ['A'])).toEqual({
      status: 'graded',
      score: 2,
      comment: 'Net force changes velocity.',
      basis: 'deterministic',
    });
    expect(gradeLearningSelection(question, ['B'])).toMatchObject({ status: 'graded', score: 0 });
  });

  it('does not reveal a generated question set until its draft is durable', async () => {
    const payload = learningPayload();
    const order: string[] = [];
    const post = vi.fn(async () => {
      order.push('generated');
      return {
        questionSet: payload.questionSet,
        coverage: payload.source.coverage,
        review: payload.generation.review,
        generation: payload.generation,
      };
    });
    const persist = vi.fn(async () => {
      order.push('persisted');
    });

    const result = await generateAndPersistLearningCheck({
      stageId: 'stage-1',
      requestId: 'request-1',
      checkId: 'check-1',
      attemptId: 'attempt-1',
      snapshot: payload.source,
      post,
      persist,
      validateBeforePersist: async () => true,
      now: () => '2026-09-14T00:00:00.000Z',
    });

    expect(order).toEqual(['generated', 'persisted']);
    expect(result).toEqual(payload);
  });

  it('aborts a course check before persistence when its stage or revision became stale', async () => {
    const payload = learningPayload();
    const persist = vi.fn(async (_stageId: string, _payload: LearningCheckPayloadV1) => undefined);

    await expect(
      generateAndPersistLearningCheck({
        stageId: 'stage-1',
        requestId: 'request-stale',
        checkId: 'check-stale',
        attemptId: 'attempt-stale',
        snapshot: payload.source,
        post: async () => ({
          questionSet: payload.questionSet,
          coverage: payload.source.coverage,
          review: payload.generation.review,
          generation: payload.generation,
        }),
        validateBeforePersist: async () => false,
        persist,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(persist).not.toHaveBeenCalled();
  });

  it('keeps persistence failure off the visible success path', async () => {
    const payload = learningPayload();
    await expect(
      generateAndPersistLearningCheck({
        stageId: 'stage-1',
        requestId: 'request-1',
        checkId: 'check-1',
        attemptId: 'attempt-1',
        snapshot: payload.source,
        post: async () => ({
          questionSet: payload.questionSet,
          coverage: payload.source.coverage,
          review: payload.generation.review,
          generation: payload.generation,
        }),
        persist: async () => {
          throw new Error('storage unavailable');
        },
        validateBeforePersist: async () => true,
        now: () => '2026-09-14T00:00:00.000Z',
      }),
    ).rejects.toThrow('storage unavailable');
  });

  it('resumes a durable draft instead of generating another question set after reopening', () => {
    const draft = learningPayload('draft');
    const stored: StoredLearningCheckAttempt = {
      sessionId: draft.identity.attemptId,
      status: 'active',
      createdAt: '2026-09-14T00:00:00.000Z',
      updatedAt: '2026-09-14T00:00:00.000Z',
      lastSeq: 0,
      payload: draft,
    };
    expect(selectResumableLearningCheck([stored])).toBe(draft);
  });

  it('persists a remediation question as an independent parent-linked attempt before revealing it', async () => {
    const parent = learningPayload('reviewed');
    const context = buildLearningRemediationContext(parent, 'q1');
    const nextQuestion = {
      ...parent.questionSet.questions[0]!,
      id: 'remediation-q1',
      prompt: 'Which property of motion can a net force change?',
    };
    const post = vi.fn(async () => ({
      questionSet: {
        ...parent.questionSet,
        questionSetId: 'remediation-set-1',
        questions: [nextQuestion],
      },
      coverage: parent.source.coverage,
      review: parent.generation.review,
      generation: parent.generation,
    }));
    const persist = vi.fn(async () => undefined);

    const result = await generateAndPersistRemediationCheck({
      stageId: 'stage-1',
      context,
      snapshot: parent.source,
      requestId: 'remediation-request-1',
      checkId: 'remediation-check-1',
      attemptId: 'remediation-attempt-1',
      post,
      persist,
      validateBeforePersist: async () => true,
      now: () => '2026-09-14T03:00:00.000Z',
    });

    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'remediation-request-1',
        scope: 'remediation',
        focus: {
          conceptId: 'force',
          priorQuestionPrompt: 'What does net force change?',
        },
      }),
    );
    expect(persist).toHaveBeenCalledWith('stage-1', result);
    expect(result.identity).toMatchObject({
      attemptId: 'remediation-attempt-1',
      parentAttemptId: 'attempt-1',
      questionId: 'q1',
      source: 'remediation_check',
    });
  });

  it('aborts remediation before persistence when the request switches stages', async () => {
    const parent = learningPayload('reviewed');
    const context = buildLearningRemediationContext(parent, 'q1');
    const persist = vi.fn(async () => undefined);

    await expect(
      generateAndPersistRemediationCheck({
        stageId: 'stage-1',
        context,
        snapshot: parent.source,
        requestId: 'remediation-request-stale',
        checkId: 'remediation-check-stale',
        attemptId: 'remediation-attempt-stale',
        post: async () => ({
          questionSet: {
            ...parent.questionSet,
            questions: [
              {
                ...parent.questionSet.questions[0]!,
                id: 'remediation-q-stale',
                prompt: 'Which motion change can result from an unbalanced force?',
              },
            ],
          },
          coverage: parent.source.coverage,
          review: parent.generation.review,
          generation: parent.generation,
        }),
        validateBeforePersist: async () => false,
        persist,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(persist).not.toHaveBeenCalled();
  });

  it('keeps a short-answer grading failure submitted and retries without changing the answer', async () => {
    const submitted = learningPayload('submitted');
    const question = submitted.questionSet.questions[0]!;
    question.type = 'short_answer';
    question.options = undefined;
    question.correctAnswer = undefined;
    submitted.lifecycle.answers.q1 = 'My frozen answer';
    submitted.lifecycle.grading.q1 = { status: 'pending' };
    submitted.questionSet.questions.push({
      ...submitted.questionSet.questions[0]!,
      id: 'q2',
      type: 'single',
      options: [
        { label: 'Motion', value: 'A' },
        { label: 'Color', value: 'B' },
      ],
      correctAnswer: ['A'],
    });
    submitted.lifecycle.answers.q2 = ['A'];
    submitted.lifecycle.grading.q2 = {
      status: 'graded',
      score: 2,
      comment: 'Already graded.',
      basis: 'deterministic',
    };
    const persist = vi.fn(async () => undefined);

    const pending = await gradeSubmittedLearningCheck({
      stageId: 'stage-1',
      payload: submitted,
      language: 'en-US',
      blankComment: 'No answer provided.',
      persist,
      gradeShort: async () => ({ status: 'error', message: 'grading-unavailable' }),
      now: () => '2026-09-14T04:00:00.000Z',
    });

    expect(pending.lifecycle).toMatchObject({
      phase: 'submitted',
      answers: { q1: 'My frozen answer' },
      grading: { q1: { status: 'error', message: 'grading-unavailable' } },
      submittedAt: '2026-09-14T00:01:00.000Z',
    });
    expect(pending.lifecycle).not.toHaveProperty('reviewedAt');

    const reviewed = await gradeSubmittedLearningCheck({
      stageId: 'stage-1',
      payload: pending,
      language: 'en-US',
      blankComment: 'No answer provided.',
      persist,
      gradeShort: async () => ({
        status: 'graded',
        score: 1,
        comment: 'Partially correct.',
        basis: 'model',
      }),
      now: () => '2026-09-14T04:01:00.000Z',
    });

    expect(reviewed.lifecycle).toMatchObject({
      phase: 'reviewed',
      answers: { q1: 'My frozen answer' },
      grading: { q1: { status: 'graded', score: 1 } },
      submittedAt: '2026-09-14T00:01:00.000Z',
      reviewedAt: '2026-09-14T04:01:00.000Z',
    });
    expect(persist).toHaveBeenNthCalledWith(1, 'stage-1', pending);
    expect(persist).toHaveBeenNthCalledWith(2, 'stage-1', reviewed);
  });

  it('re-reads merged concurrent grades before deciding whether the attempt is reviewed', async () => {
    const submitted = learningPayload('submitted');
    submitted.questionSet.questions.push({
      ...submitted.questionSet.questions[0]!,
      id: 'q2',
      type: 'short_answer',
      options: undefined,
      correctAnswer: undefined,
      conceptId: 'acceleration',
    });
    submitted.lifecycle.answers.q2 = 'My q2 answer';
    submitted.lifecycle.grading = { q1: { status: 'pending' }, q2: { status: 'pending' } };
    const merged = structuredClone(submitted);
    merged.lifecycle.grading = {
      q1: {
        status: 'graded',
        score: 2,
        comment: 'Tab A.',
        basis: 'deterministic',
      },
      q2: {
        status: 'graded',
        score: 0,
        comment: 'Tab B.',
        basis: 'deterministic',
      },
    };
    const persist = vi.fn(async (_stageId: string, _payload: LearningCheckPayloadV1) => undefined);

    const result = await gradeSubmittedLearningCheck({
      stageId: 'stage-1',
      payload: submitted,
      language: 'en-US',
      blankComment: 'No answer provided.',
      persist,
      gradeShort: async () => ({ status: 'error', message: 'grading-unavailable' }),
      readLatest: async () => merged,
      now: () => '2026-09-14T05:00:00.000Z',
    });

    expect(result.lifecycle).toMatchObject({
      phase: 'reviewed',
      answers: submitted.lifecycle.answers,
      grading: merged.lifecycle.grading,
      reviewedAt: '2026-09-14T05:00:00.000Z',
    });
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist.mock.calls[1]?.[1]).toMatchObject({ lifecycle: { phase: 'reviewed' } });
  });
});
