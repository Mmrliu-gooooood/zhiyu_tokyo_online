import { beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { BrowserRuntimeStore } from '@openmaic/storage';
import {
  applyQuizGrade,
  createQuizQuestionSnapshot,
  quizContentRevision,
  quizSubmittedDigest,
  type QuizAttemptPayloadV2,
} from '@/lib/quiz/attempt-schema';
import {
  loadQuizAttemptState,
  QuizAttemptEvidenceChangedError,
  QuizSubmittedAnswersChangedError,
  recordQuizAttempt,
} from '@/lib/quiz/runtime';

describe('quiz runtime v2', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'IDBKeyRange', { configurable: true, value: IDBKeyRange });
  });

  it('persists and restores submitted answers with their immutable question snapshot', async () => {
    const store = new BrowserRuntimeStore({
      indexedDB: new IDBFactory(),
      dbName: `quiz-runtime-v2-${Math.random()}`,
    });
    const deps = {
      store,
      learnerKey: 'learner-1',
      now: () => '2026-09-14T00:00:00.000Z',
      mintRecordId: () => 'record-1',
    };
    const questionSnapshot = createQuizQuestionSnapshot([
      { id: 'q1', type: 'single', question: 'Original?', answer: ['a'], points: 2 },
    ]);
    const contentRevision = quizContentRevision(questionSnapshot);
    const answers = { q1: 'a' };

    await recordQuizAttempt(
      {
        stageId: 'stage-1',
        sceneId: 'scene-1',
        attemptId: 'attempt-1',
        phase: 'submitted',
        answers,
        v2: {
          questionSnapshot,
          contentRevision,
          grading: { q1: { status: 'pending' } },
          results: [],
          gradeProvenance: {},
          submittedDigest: quizSubmittedDigest(contentRevision, answers),
        },
      },
      deps,
    );

    await expect(
      loadQuizAttemptState({ stageId: 'stage-1', sceneId: 'scene-1' }, deps),
    ).resolves.toMatchObject({
      state: {
        payloadVersion: 2,
        phase: 'submitted',
        answers,
        questionSnapshot,
        contentRevision,
        grading: { q1: { status: 'pending' } },
        results: [],
      },
    });
  });

  it('rejects answer changes on the same submitted attempt', async () => {
    const store = new BrowserRuntimeStore({
      indexedDB: new IDBFactory(),
      dbName: `quiz-runtime-v2-freeze-${Math.random()}`,
    });
    let record = 0;
    const deps = {
      store,
      learnerKey: 'learner-1',
      now: () => `2026-09-14T00:00:0${record}.000Z`,
      mintRecordId: () => `record-${record++}`,
    };
    const questionSnapshot = createQuizQuestionSnapshot([
      { id: 'q1', type: 'single', question: 'Original?', answer: ['a'], points: 2 },
    ]);
    const contentRevision = quizContentRevision(questionSnapshot);
    const base = {
      stageId: 'stage-1',
      sceneId: 'scene-1',
      attemptId: 'attempt-1',
      phase: 'submitted' as const,
    };
    const buildV2 = (answers: { q1: string }) => ({
      questionSnapshot,
      contentRevision,
      grading: { q1: { status: 'pending' as const } },
      results: [],
      gradeProvenance: {},
      submittedDigest: quizSubmittedDigest(contentRevision, answers),
    });

    await recordQuizAttempt({ ...base, answers: { q1: 'a' }, v2: buildV2({ q1: 'a' }) }, deps);

    await expect(
      recordQuizAttempt({ ...base, answers: { q1: 'b' }, v2: buildV2({ q1: 'b' }) }, deps),
    ).rejects.toBeInstanceOf(QuizSubmittedAnswersChangedError);
    await expect(
      loadQuizAttemptState({ stageId: 'stage-1', sceneId: 'scene-1' }, deps),
    ).resolves.toMatchObject({ state: { answers: { q1: 'a' } } });
  });

  it('rejects replacing the question snapshot on an existing v2 attempt', async () => {
    const store = new BrowserRuntimeStore({
      indexedDB: new IDBFactory(),
      dbName: `quiz-runtime-v2-evidence-${Math.random()}`,
    });
    let record = 0;
    const deps = {
      store,
      learnerKey: 'learner-1',
      now: () => `2026-09-14T00:00:0${record}.000Z`,
      mintRecordId: () => `record-${record++}`,
    };
    const original = createQuizQuestionSnapshot([
      { id: 'q1', type: 'single', question: 'Original?', answer: ['a'], points: 2 },
    ]);
    const edited = createQuizQuestionSnapshot([
      { id: 'q1', type: 'single', question: 'Edited?', answer: ['b'], points: 2 },
    ]);
    const answers = { q1: 'a' };
    const input = (questionSnapshot: typeof original) => {
      const contentRevision = quizContentRevision(questionSnapshot);
      return {
        stageId: 'stage-1',
        sceneId: 'scene-1',
        attemptId: 'attempt-1',
        phase: 'submitted' as const,
        answers,
        v2: {
          questionSnapshot,
          contentRevision,
          grading: { q1: { status: 'pending' as const } },
          results: [],
          gradeProvenance: {},
          submittedDigest: quizSubmittedDigest(contentRevision, answers),
        },
      };
    };
    await recordQuizAttempt(input(original), deps);

    await expect(recordQuizAttempt(input(edited), deps)).rejects.toBeInstanceOf(
      QuizAttemptEvidenceChangedError,
    );
  });

  it('keeps the first persisted grade when two tabs submit conflicting results', async () => {
    const store = new BrowserRuntimeStore({
      indexedDB: new IDBFactory(),
      dbName: `quiz-runtime-v2-grade-cas-${Math.random()}`,
    });
    let record = 0;
    const deps = {
      store,
      learnerKey: 'learner-1',
      now: () => new Date(Date.UTC(2026, 8, 14, 0, 0, record)).toISOString(),
      mintRecordId: () => `record-${record++}`,
    };
    const questionSnapshot = createQuizQuestionSnapshot([
      {
        id: 'q1',
        type: 'short_answer',
        question: 'Explain?',
        commentPrompt: 'Use evidence',
        points: 2,
      },
    ]);
    const contentRevision = quizContentRevision(questionSnapshot);
    const answers = { q1: 'evidence' };
    const basePayload = {
      payloadVersion: 2 as const,
      phase: 'submitted' as const,
      questionSnapshot,
      contentRevision,
      answers,
      grading: { q1: { status: 'pending' as const } },
      results: [],
      gradeProvenance: {},
      submittedDigest: quizSubmittedDigest(contentRevision, answers),
    };
    const provenance = {
      ruleVersion: 'quiz-grading-v1',
      model: 'model-a',
      basis: 'rubric' as const,
      gradedAt: '2026-09-14T00:00:00.000Z',
    };
    const first = applyQuizGrade(
      basePayload,
      { questionId: 'q1', correct: true, status: 'correct', earned: 2 },
      provenance,
    );
    const conflicting = applyQuizGrade(
      basePayload,
      { questionId: 'q1', correct: false, status: 'incorrect', earned: 0 },
      { ...provenance, model: 'model-b' },
    );
    const input = (payload: QuizAttemptPayloadV2) => ({
      stageId: 'stage-1',
      sceneId: 'scene-1',
      attemptId: 'attempt-1',
      phase: 'submitted' as const,
      answers,
      v2: {
        questionSnapshot: payload.questionSnapshot,
        contentRevision: payload.contentRevision,
        grading: payload.grading,
        results: payload.results,
        gradeProvenance: payload.gradeProvenance,
        submittedDigest: payload.submittedDigest,
      },
    });

    await recordQuizAttempt(input(first), deps);
    await recordQuizAttempt(input(conflicting), deps);

    await expect(
      loadQuizAttemptState({ stageId: 'stage-1', sceneId: 'scene-1' }, deps),
    ).resolves.toMatchObject({ state: { results: [{ questionId: 'q1', earned: 2 }] } });
  });
});
