import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/quiz/runtime', () => ({
  loadQuizAttemptState: vi.fn(),
}));

import {
  buildQuizResultsForStoreState,
  didActiveSceneRemainUnchanged,
} from '@/lib/chat/quiz-results-for-store-state';
import { loadQuizAttemptState } from '@/lib/quiz/runtime';

describe('quiz results for chat store state', () => {
  beforeEach(() => {
    vi.mocked(loadQuizAttemptState).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('omits an explicitly reviewed quiz when the grader returned no results', async () => {
    vi.mocked(loadQuizAttemptState).mockResolvedValue({
      attemptId: 'attempt-1',
      state: {
        sessionId: 'attempt-1',
        status: 'completed',
        phase: 'reviewed',
        answers: { q1: 'A' },
        results: [],
      },
    });

    await expect(
      buildQuizResultsForStoreState([{ id: 'quiz-1', type: 'quiz', stageId: 'stage-1' }], 'quiz-1'),
    ).resolves.toBeUndefined();
    expect(loadQuizAttemptState).toHaveBeenCalledWith({
      stageId: 'stage-1',
      sceneId: 'quiz-1',
    });
  });

  it('omits partially graded v2 attempts so pending work cannot be presented as final feedback', async () => {
    vi.mocked(loadQuizAttemptState).mockResolvedValue({
      attemptId: 'attempt-1',
      state: {
        sessionId: 'attempt-1',
        status: 'active',
        payloadVersion: 2,
        phase: 'submitted',
        answers: { q1: 'A', q2: 'B' },
        questionSnapshot: [
          { id: 'q1', type: 'single', question: 'One', points: 1 },
          { id: 'q2', type: 'short_answer', question: 'Two', points: 1 },
        ],
        grading: {
          q1: {
            status: 'graded',
            result: { questionId: 'q1', correct: true, status: 'correct', earned: 1 },
            provenance: {
              ruleVersion: 'quiz-grading-v1',
              basis: 'answer-key',
              gradedAt: '2026-09-14T00:00:00.000Z',
            },
          },
          q2: { status: 'pending', error: { code: 'NETWORK_ERROR', retryable: true } },
        },
        results: [{ questionId: 'q1', correct: true, status: 'correct', earned: 1 }],
      },
    });

    await expect(
      buildQuizResultsForStoreState([{ id: 'quiz-1', type: 'quiz', stageId: 'stage-1' }], 'quiz-1'),
    ).resolves.toBeUndefined();
  });

  it('includes non-empty reviewed results for the active quiz', async () => {
    const results = [{ questionId: 'q1', correct: true, status: 'correct' as const, earned: 1 }];
    vi.mocked(loadQuizAttemptState).mockResolvedValue({
      attemptId: 'attempt-1',
      state: {
        sessionId: 'attempt-1',
        status: 'completed',
        phase: 'reviewed',
        answers: { q1: 'A' },
        results,
      },
    });

    await expect(
      buildQuizResultsForStoreState([{ id: 'quiz-1', type: 'quiz', stageId: 'stage-1' }], 'quiz-1'),
    ).resolves.toEqual({ sceneId: 'quiz-1', answers: { q1: 'A' }, results });
  });

  it('omits quiz context when RuntimeStore is unavailable', async () => {
    vi.mocked(loadQuizAttemptState).mockRejectedValue(new Error('indexedDB unavailable'));

    await expect(
      buildQuizResultsForStoreState([{ id: 'quiz-1', type: 'quiz', stageId: 'stage-1' }], 'quiz-1'),
    ).resolves.toBeUndefined();
  });

  it('times out a stalled RuntimeStore read instead of blocking chat', async () => {
    vi.useFakeTimers();
    vi.mocked(loadQuizAttemptState).mockReturnValue(new Promise(() => {}));

    const reading = buildQuizResultsForStoreState(
      [{ id: 'quiz-1', type: 'quiz', stageId: 'stage-1' }],
      'quiz-1',
    );
    await vi.runAllTimersAsync();

    await expect(reading).resolves.toBeUndefined();
  });

  it('retains quiz results when the active scene object was reallocated in place', () => {
    // A store update may replace the scene object (same id) during the async
    // quiz read; the learner never left the scene, so their graded answers
    // must still reach the outgoing request. The scene ID is the boundary.
    const before = {
      id: 'quiz-1',
      type: 'quiz',
      stageId: 'stage-1',
      content: { questions: ['old'] },
    };
    const after = { ...before, content: { questions: ['new'] } };

    expect(didActiveSceneRemainUnchanged([before], 'quiz-1', [after], 'quiz-1')).toBe(true);
  });

  it('rejects quiz results when the active scene left the deck during the read', () => {
    const before = { id: 'quiz-1', type: 'quiz', stageId: 'stage-1', content: {} };

    expect(didActiveSceneRemainUnchanged([before], 'quiz-1', [], 'quiz-1')).toBe(false);
  });

  it('retains quiz results when unrelated scenes changed during the read', () => {
    const quiz = {
      id: 'quiz-1',
      type: 'quiz',
      stageId: 'stage-1',
      content: { questions: ['same'] },
    };
    const editedSlide = { id: 'slide-1', title: 'edited' };

    expect(
      didActiveSceneRemainUnchanged(
        [quiz, { id: 'slide-1' }],
        'quiz-1',
        [quiz, editedSlide],
        'quiz-1',
      ),
    ).toBe(true);
  });
});
