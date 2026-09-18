import { describe, it, expect, vi } from 'vitest';
import {
  completeSummaryForScenes,
  pendingCompleteSummary,
  readSceneQuizAttempt,
  summarizeScenes,
} from '@/lib/classroom/complete-summary';
import type { QuizAttemptState } from '@/lib/quiz/runtime';
import type { Scene, QuizQuestion } from '@/lib/types/stage';

function slide(id: string, order: number): Scene {
  return {
    id,
    stageId: 's1',
    type: 'slide',
    title: id,
    order,
    content: { type: 'slide', canvas: {} as never },
  };
}

function quizScene(id: string, order: number, questions: QuizQuestion[]): Scene {
  return {
    id,
    stageId: 's1',
    type: 'quiz',
    title: id,
    order,
    content: { type: 'quiz', questions },
  };
}

function interactive(id: string, order: number): Scene {
  return {
    id,
    stageId: 's1',
    type: 'interactive',
    title: id,
    order,
    content: { type: 'interactive', url: 'about:blank' },
  };
}

const choiceQ = (id: string, answer: string[]): QuizQuestion => ({
  id,
  type: 'single',
  question: id,
  options: [
    { value: 'a', label: 'A' },
    { value: 'b', label: 'B' },
  ],
  answer,
  hasAnswer: true,
  points: 1,
});

function v2Attempt(
  questions: NonNullable<QuizAttemptState['questionSnapshot']>,
  grading: NonNullable<QuizAttemptState['grading']>,
): QuizAttemptState {
  return {
    sessionId: 'attempt-1',
    status: 'active',
    payloadVersion: 2,
    phase: 'submitted',
    answers: {},
    questionSnapshot: questions,
    grading,
    results: Object.values(grading).flatMap((entry) =>
      entry.status === 'graded' ? [entry.result] : [],
    ),
  };
}

describe('summarizeScenes', () => {
  it('projects objective accuracy from the frozen v2 grading facts instead of current questions', async () => {
    const scenes = [quizScene('q1', 0, [choiceQ('qa', ['b'])])];

    const result = await summarizeScenes(scenes, async () => ({
      sessionId: 'attempt-1',
      status: 'active',
      payloadVersion: 2,
      phase: 'submitted',
      answers: { qa: 'a' },
      questionSnapshot: [
        {
          id: 'qa',
          type: 'single',
          question: 'The historical question',
          options: [
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B' },
          ],
          answer: ['a'],
          points: 1,
        },
      ],
      grading: {
        qa: {
          status: 'graded',
          result: { questionId: 'qa', correct: true, status: 'correct', earned: 1 },
          provenance: {
            ruleVersion: 'quiz-grading-v1',
            basis: 'answer-key',
            gradedAt: '2026-09-14T00:00:00.000Z',
          },
        },
      },
      results: [{ questionId: 'qa', correct: true, status: 'correct', earned: 1 }],
    }));

    expect(result.quiz).toEqual({ correct: 1, total: 1, pct: 100 });
    expect(result.quizStatus).toEqual({ pending: 0, unavailable: 0, legacyAttempts: 0 });
  });

  it('skips a legacy scene without stageId before loading runtime answers', async () => {
    const { stageId: _stageId, ...legacy } = quizScene('legacy', 0, [choiceQ('qa', ['a'])]);
    const load = vi.fn();

    await expect(readSceneQuizAttempt(legacy, load)).resolves.toBeUndefined();
    expect(load).not.toHaveBeenCalled();
  });

  it('shows the new classroom baseline while its async summary is pending', () => {
    const previousScenes = [quizScene('old', 0, [choiceQ('old-q', ['a'])])];
    const nextScenes = [slide('new-1', 0), slide('new-2', 1)];
    const previous = {
      scenes: previousScenes,
      summary: {
        countsByType: { quiz: 1 },
        quiz: { correct: 1, total: 1, pct: 100 },
        quizStatus: { pending: 0, unavailable: 0, legacyAttempts: 0 },
      },
    };

    expect(completeSummaryForScenes(nextScenes, previous)).toEqual({
      countsByType: { slide: 2 },
      quiz: null,
      quizStatus: { pending: 0, unavailable: 0, legacyAttempts: 0 },
    });
  });

  it('seeds a new completion page with its synchronous scene-count baseline', () => {
    const scenes = [slide('new-1', 0), slide('new-2', 1), interactive('new-3', 2)];

    expect(pendingCompleteSummary(scenes)).toEqual({
      countsByType: { slide: 2, interactive: 1 },
      quiz: null,
      quizStatus: { pending: 0, unavailable: 0, legacyAttempts: 0 },
    });
  });

  it('counts scenes by type and omits zeros', async () => {
    const scenes = [slide('s1', 0), slide('s2', 1), interactive('i1', 2)];
    const result = await summarizeScenes(scenes, async () => undefined);
    expect(result.countsByType).toEqual({ slide: 2, interactive: 1 });
    expect(result.quiz).toBeNull();
  });

  it('returns null quiz when no quiz scenes exist', async () => {
    const result = await summarizeScenes([slide('s1', 0)], async () => undefined);
    expect(result.quiz).toBeNull();
  });

  it('aggregates persisted objective grading facts across multiple quiz scenes', async () => {
    const scenes = [
      quizScene('q1', 0, [choiceQ('qa', ['a']), choiceQ('qb', ['b'])]),
      quizScene('q2', 1, [choiceQ('qc', ['a'])]),
    ];
    const attempts: Record<string, QuizAttemptState> = {
      q1: v2Attempt(
        [
          { id: 'qa', type: 'single', question: 'qa', points: 1 },
          { id: 'qb', type: 'single', question: 'qb', points: 1 },
        ],
        {
          qa: {
            status: 'graded',
            result: { questionId: 'qa', correct: true, status: 'correct', earned: 1 },
            provenance: {
              ruleVersion: 'v1',
              basis: 'answer-key',
              gradedAt: '2026-09-14T00:00:00.000Z',
            },
          },
          qb: {
            status: 'graded',
            result: { questionId: 'qb', correct: false, status: 'incorrect', earned: 0 },
            provenance: {
              ruleVersion: 'v1',
              basis: 'answer-key',
              gradedAt: '2026-09-14T00:00:00.000Z',
            },
          },
        },
      ),
      q2: v2Attempt([{ id: 'qc', type: 'single', question: 'qc', points: 1 }], {
        qc: {
          status: 'graded',
          result: { questionId: 'qc', correct: true, status: 'correct', earned: 1 },
          provenance: {
            ruleVersion: 'v1',
            basis: 'answer-key',
            gradedAt: '2026-09-14T00:00:00.000Z',
          },
        },
      }),
    };
    const result = await summarizeScenes(scenes, async (sceneId) => attempts[sceneId]);
    expect(result.quiz).toEqual({ correct: 2, total: 3, pct: Math.round((2 / 3) * 100) });
    expect(result.countsByType.quiz).toBe(2);
  });

  it('returns null quiz when quiz scenes exist but have no gradeable questions', async () => {
    const saOnly = quizScene('q1', 0, [
      {
        id: 'sa',
        type: 'short_answer',
        question: 'x',
        answer: [],
        hasAnswer: false,
      },
    ]);
    const result = await summarizeScenes([saOnly], async () =>
      v2Attempt([{ id: 'sa', type: 'short_answer', question: 'x', points: 1 }], {
        sa: {
          status: 'graded',
          result: { questionId: 'sa', correct: true, status: 'correct', earned: 1 },
          provenance: {
            ruleVersion: 'v1',
            basis: 'rubric',
            gradedAt: '2026-09-14T00:00:00.000Z',
          },
        },
      }),
    );
    expect(result.quiz).toBeNull();
    expect(result.countsByType.quiz).toBe(1);
  });

  it('excludes pending and unavailable questions from objective accuracy', async () => {
    const scenes = [quizScene('q1', 0, [choiceQ('qa', ['a']), choiceQ('qb', ['b'])])];
    const result = await summarizeScenes(scenes, async () =>
      v2Attempt(
        [
          { id: 'qa', type: 'single', question: 'qa', points: 1 },
          { id: 'qb', type: 'single', question: 'qb', points: 1 },
        ],
        {
          qa: { status: 'pending', error: { code: 'NETWORK_ERROR', retryable: true } },
          qb: {
            status: 'unavailable',
            error: { code: 'MISSING_ANSWER_KEY', retryable: false },
          },
        },
      ),
    );
    expect(result.quiz).toBeNull();
    expect(result.quizStatus).toEqual({ pending: 1, unavailable: 1, legacyAttempts: 0 });
  });

  it('omits quiz scenes whose authoritative answers are unavailable', async () => {
    const scenes = [
      quizScene('unavailable', 0, [choiceQ('qa', ['a'])]),
      quizScene('available', 1, [choiceQ('qb', ['b'])]),
    ];

    const result = await summarizeScenes(scenes, async (sceneId) => {
      if (sceneId === 'unavailable') throw new Error('storage unavailable');
      return v2Attempt([{ id: 'qb', type: 'single', question: 'qb', points: 1 }], {
        qb: {
          status: 'graded',
          result: { questionId: 'qb', correct: true, status: 'correct', earned: 1 },
          provenance: {
            ruleVersion: 'v1',
            basis: 'answer-key',
            gradedAt: '2026-09-14T00:00:00.000Z',
          },
        },
      });
    });

    expect(result.quiz).toEqual({ correct: 1, total: 1, pct: 100 });
  });

  it('marks submitted v1 attempts as legacy without reconstructing their questions', async () => {
    const result = await summarizeScenes(
      [quizScene('q1', 0, [choiceQ('current', ['a'])])],
      async () => ({
        sessionId: 'legacy-attempt',
        status: 'completed',
        payloadVersion: 1,
        phase: 'reviewed',
        answers: { historical: 'b' },
        results: [{ questionId: 'historical', correct: true, status: 'correct', earned: 1 }],
      }),
    );

    expect(result.quiz).toBeNull();
    expect(result.quizStatus).toEqual({ pending: 0, unavailable: 0, legacyAttempts: 1 });
  });
});
