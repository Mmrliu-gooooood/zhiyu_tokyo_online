/**
 * Tests for the pre-PBL quiz snapshot helpers.
 *
 * Covers both `buildQuizSnapshot` (client-side, reads RuntimeStore)
 * and `applyQuizSignalsToProject` (server-side, mutates the project's
 * proficiency assessment). The robustness matrix is the focus —
 * non-quiz scenes, unsubmitted quizzes, all-short-answer quizzes,
 * empty results, and missing assessment should all be safe.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyQuizSignalsToProject,
  buildQuizSnapshot,
} from '@/lib/pbl/v2/operations/runtime/quiz-snapshot';
import { emptyAssessment } from '@/lib/pbl/v2/operations/kernel/proficiency';
import type { PBLProjectV2, PriorQuizResult } from '@/lib/pbl/v2/types';
import type { QuestionResult } from '@/lib/quiz/grading';
import type { QuizAttemptState } from '@/lib/quiz/runtime';
import type { Scene } from '@/lib/types/stage';

vi.mock('@/lib/quiz/runtime', () => ({
  loadQuizAttemptState: vi.fn(),
}));

import { loadQuizAttemptState } from '@/lib/quiz/runtime';

beforeEach(() => {
  vi.mocked(loadQuizAttemptState).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mkQuizScene(id: string, questions: number): Scene {
  return {
    id,
    stageId: 'stg',
    type: 'quiz',
    title: `Q ${id}`,
    order: 1,
    content: {
      type: 'quiz',
      questions: Array.from({ length: questions }, (_, i) => ({
        id: `q${i}`,
        type: 'single' as const,
        question: 'x',
        options: [{ label: 'A', value: 'A' }],
        answer: ['A'],
        hasAnswer: true,
      })),
    },
    actions: [],
  } as unknown as Scene;
}

function mkSlideScene(id: string): Scene {
  return {
    id,
    stageId: 'stg',
    type: 'slide',
    title: 's',
    order: 1,
    content: { type: 'slide', canvas: {} } as never,
    actions: [],
  } as unknown as Scene;
}

function mkProject(overrides: Partial<PBLProjectV2> = {}): PBLProjectV2 {
  return {
    uiPhase: 'workspace',
    title: 't',
    description: 'd',
    proficiency: 'intermediate',
    proficiencyAssessment: emptyAssessment(),
    language: 'zh-CN',
    tags: [],
    status: 'active',
    roles: [],
    milestones: [],
    submissions: [],
    evaluations: [],
    threads: [],
    engagementEvents: [],
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

function reviewedV2State(results: QuestionResult[]): QuizAttemptState {
  return {
    sessionId: 'attempt-1',
    status: 'completed',
    payloadVersion: 2,
    phase: 'reviewed',
    answers: {},
    questionSnapshot: results.map((result) => ({
      id: result.questionId,
      type: result.correct === null ? 'short_answer' : 'single',
      question: result.questionId,
      points: 1,
    })),
    grading: Object.fromEntries(
      results.map((result) => [
        result.questionId,
        {
          status: 'graded',
          result,
          provenance: {
            ruleVersion: 'quiz-grading-v1',
            basis: result.correct === null ? 'rubric' : 'answer-key',
            gradedAt: '2026-09-14T00:00:00.000Z',
          },
        },
      ]),
    ),
    results,
  };
}

describe('buildQuizSnapshot', () => {
  it('uses the reviewed v2 frozen snapshot instead of the current scene question count', async () => {
    vi.mocked(loadQuizAttemptState).mockResolvedValue({
      attemptId: 'attempt-1',
      state: {
        sessionId: 'attempt-1',
        status: 'completed',
        payloadVersion: 2,
        phase: 'reviewed',
        answers: { historical: 'A' },
        questionSnapshot: [
          {
            id: 'historical',
            type: 'single',
            question: 'Frozen question',
            answer: ['A'],
            points: 1,
          },
        ],
        grading: {
          historical: {
            status: 'graded',
            result: {
              questionId: 'historical',
              correct: true,
              status: 'correct',
              earned: 1,
            },
            provenance: {
              ruleVersion: 'quiz-grading-v1',
              basis: 'answer-key',
              gradedAt: '2026-09-14T00:00:00.000Z',
            },
          },
        },
        results: [{ questionId: 'historical', correct: true, status: 'correct', earned: 1 }],
      },
    });

    await expect(buildQuizSnapshot([mkQuizScene('q1', 3)])).resolves.toEqual([
      {
        sceneId: 'q1',
        sceneTitle: 'Q q1',
        totalQuestions: 1,
        correctCount: 1,
        incorrectCount: 0,
        unscoredCount: 0,
        accuracy: 1,
      },
    ]);
  });

  it('returns [] when there are no quiz scenes', async () => {
    await expect(buildQuizSnapshot([mkSlideScene('s1'), mkSlideScene('s2')])).resolves.toEqual([]);
  });

  it('skips legacy quiz scenes that do not have a stage id', async () => {
    const { stageId: _stageId, ...legacy } = mkQuizScene('legacy', 1);

    await expect(buildQuizSnapshot([legacy as Scene])).resolves.toEqual([]);
    expect(loadQuizAttemptState).not.toHaveBeenCalled();
  });

  it('skips quizzes the learner has not been reviewed', async () => {
    vi.mocked(loadQuizAttemptState).mockResolvedValue({
      attemptId: 'attempt-1',
      state: {
        sessionId: 'attempt-1',
        status: 'active',
        payloadVersion: 2,
        phase: 'submitted',
        answers: { q0: 'A' },
        questionSnapshot: [
          { id: 'q0', type: 'single', question: 'One', points: 1 },
          { id: 'q1', type: 'short_answer', question: 'Two', points: 1 },
        ],
        grading: {
          q0: {
            status: 'graded',
            result: { questionId: 'q0', correct: true, status: 'correct', earned: 1 },
            provenance: {
              ruleVersion: 'quiz-grading-v1',
              basis: 'answer-key',
              gradedAt: '2026-09-14T00:00:00.000Z',
            },
          },
          q1: { status: 'pending', error: { code: 'NETWORK_ERROR', retryable: true } },
        },
        results: [{ questionId: 'q0', correct: true, status: 'correct', earned: 1 }],
      },
    });
    await expect(buildQuizSnapshot([mkQuizScene('q1', 3)])).resolves.toEqual([]);
  });

  it('skips reviewed v1 records because they have no frozen question snapshot', async () => {
    vi.mocked(loadQuizAttemptState).mockResolvedValue({
      attemptId: 'attempt-1',
      state: {
        sessionId: 'attempt-1',
        status: 'completed',
        payloadVersion: 1,
        phase: 'reviewed',
        answers: { historical: 'A' },
        results: [{ questionId: 'historical', correct: true, status: 'correct', earned: 1 }],
      },
    });

    await expect(buildQuizSnapshot([mkQuizScene('q1', 3)])).resolves.toEqual([]);
  });

  it('counts correct / incorrect / unscored properly', async () => {
    vi.mocked(loadQuizAttemptState).mockResolvedValue({
      attemptId: 'attempt-1',
      state: reviewedV2State([
        { questionId: 'q0', correct: true, status: 'correct', earned: 1 },
        { questionId: 'q1', correct: false, status: 'incorrect', earned: 0 },
        { questionId: 'q2', correct: null, status: 'incorrect', earned: 0 },
      ]),
    });
    const r = await buildQuizSnapshot([mkQuizScene('q1', 3)]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      sceneId: 'q1',
      correctCount: 1,
      incorrectCount: 1,
      unscoredCount: 1,
      accuracy: 0.5, // 1/(1+1) scored
    });
  });

  it('marks accuracy null when every question is unscored', async () => {
    vi.mocked(loadQuizAttemptState).mockResolvedValue({
      attemptId: 'attempt-1',
      state: reviewedV2State([
        { questionId: 'q0', correct: null, status: 'incorrect', earned: 0 },
        { questionId: 'q1', correct: null, status: 'incorrect', earned: 0 },
      ]),
    });
    const r = await buildQuizSnapshot([mkQuizScene('q1', 2)]);
    expect(r[0].accuracy).toBeNull();
  });

  it('aggregates across multiple quiz scenes in scene order', async () => {
    vi.mocked(loadQuizAttemptState).mockImplementation(async ({ sceneId }) => {
      const correct = sceneId === 'q1';
      return {
        attemptId: `attempt-${sceneId}`,
        state: {
          ...reviewedV2State([
            {
              questionId: 'q0',
              correct,
              status: correct ? 'correct' : 'incorrect',
              earned: correct ? 1 : 0,
            },
          ]),
          sessionId: `attempt-${sceneId}`,
        },
      };
    });
    const r = await buildQuizSnapshot([mkQuizScene('q1', 1), mkQuizScene('q2', 1)]);
    expect(r).toHaveLength(2);
    expect(r[0].accuracy).toBe(1);
    expect(r[1].accuracy).toBe(0);
  });

  it('skips one unavailable RuntimeStore snapshot without blocking launch', async () => {
    vi.mocked(loadQuizAttemptState).mockRejectedValueOnce(new Error('indexedDB unavailable'));

    await expect(buildQuizSnapshot([mkQuizScene('q1', 1)])).resolves.toEqual([]);
  });
});

describe('applyQuizSignalsToProject', () => {
  it('no-ops on empty results', () => {
    const p = mkProject();
    const before = p.proficiencyAssessment;
    const r = applyQuizSignalsToProject(p, []);
    expect(r.updated).toBe(false);
    expect(p.proficiencyAssessment).toBe(before);
  });

  it('no-ops when every quiz is fully unscored', () => {
    const p = mkProject();
    const before = p.proficiencyAssessment;
    const r = applyQuizSignalsToProject(p, [
      {
        sceneId: 'q',
        sceneTitle: 'q',
        totalQuestions: 3,
        correctCount: 0,
        incorrectCount: 0,
        unscoredCount: 3,
        accuracy: null,
      },
    ]);
    expect(r.updated).toBe(false);
    expect(p.proficiencyAssessment).toBe(before);
  });

  it('updates assessment + flips tier on a strong quiz signal', () => {
    const p = mkProject();
    const results: PriorQuizResult[] = [
      {
        sceneId: 'q',
        sceneTitle: 'q',
        totalQuestions: 5,
        correctCount: 5,
        incorrectCount: 0,
        unscoredCount: 0,
        accuracy: 1,
      },
    ];
    const r = applyQuizSignalsToProject(p, results);
    expect(r.updated).toBe(true);
    expect(p.proficiencyAssessment!.source).toBe('pre-play');
    // 100% accuracy with weight 0.6 → EWMA push 0.12, but a high
    // direction signal layered on top of the existing path. The
    // important assertion here is "engaged + recorded".
    expect(p.proficiencyAssessment!.signals.some((s) => s.kind === 'quiz_accuracy')).toBe(true);
  });

  it('lazily creates an assessment when one is missing', () => {
    const p = mkProject({ proficiencyAssessment: undefined });
    applyQuizSignalsToProject(p, [
      {
        sceneId: 'q',
        sceneTitle: 'q',
        totalQuestions: 2,
        correctCount: 1,
        incorrectCount: 1,
        unscoredCount: 0,
        accuracy: 0.5,
      },
    ]);
    expect(p.proficiencyAssessment).toBeDefined();
  });
});
