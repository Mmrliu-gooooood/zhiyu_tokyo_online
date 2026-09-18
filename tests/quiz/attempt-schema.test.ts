import { describe, expect, it } from 'vitest';
import {
  applyQuizGrade,
  createSubmittedQuizGrading,
  createQuizQuestionSnapshot,
  quizContentRevision,
  quizSubmittedDigest,
} from '@/lib/quiz/attempt-schema';
import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import type { QuizQuestion } from '@/lib/types/stage';

describe('quiz attempt schema v2', () => {
  it('freezes the original question evidence independently from later course edits', () => {
    const questions: QuizQuestion[] = [
      {
        id: 'q1',
        type: 'single',
        question: 'Original question',
        options: [
          { value: 'a', label: 'Original A' },
          { value: 'b', label: 'B' },
        ],
        answer: ['a'],
        analysis: 'Original explanation',
        commentPrompt: 'Original rubric',
        points: 2,
      },
    ];

    const snapshot = createQuizQuestionSnapshot(questions);
    const revision = quizContentRevision(snapshot);
    questions[0].question = 'Edited question';
    questions[0].options![0].label = 'Edited A';
    questions[0].answer![0] = 'b';

    expect(snapshot).toEqual([
      {
        id: 'q1',
        type: 'single',
        question: 'Original question',
        options: [
          { value: 'a', label: 'Original A' },
          { value: 'b', label: 'B' },
        ],
        answer: ['a'],
        analysis: 'Original explanation',
        commentPrompt: 'Original rubric',
        points: 2,
      },
    ]);
    expect(quizContentRevision(snapshot)).toBe(revision);
    expect(quizContentRevision(createQuizQuestionSnapshot(questions))).not.toBe(revision);
  });

  it('accepts a structurally consistent v2 payload through the app runtime validator', () => {
    const result = { questionId: 'q1', correct: true, status: 'correct' as const, earned: 2 };
    const provenance = {
      ruleVersion: 'quiz-grading-v1',
      basis: 'answer-key' as const,
      gradedAt: '2026-09-14T00:00:00.000Z',
    };
    const questionSnapshot = [
      { id: 'q1', type: 'single' as const, question: 'Q?', answer: ['a'], points: 2 },
    ];
    const contentRevision = quizContentRevision(questionSnapshot);
    const answers = { q1: 'a' };
    const validation = APP_RUNTIME_PAYLOAD_VALIDATORS.quizAttempt({
      payloadVersion: 2,
      phase: 'reviewed',
      questionSnapshot,
      contentRevision,
      answers,
      grading: { q1: { status: 'graded', result, provenance } },
      results: [result],
      gradeProvenance: { q1: provenance },
      submittedDigest: quizSubmittedDigest(contentRevision, answers),
    });

    expect(validation).toEqual({ valid: true });
  });

  it('rejects reviewed v2 payloads whose compatibility results are not graded facts', () => {
    const questionSnapshot = [
      { id: 'q1', type: 'single' as const, question: 'Q?', answer: ['a'], points: 2 },
    ];
    const contentRevision = quizContentRevision(questionSnapshot);
    const answers = { q1: 'a' };
    const validation = APP_RUNTIME_PAYLOAD_VALIDATORS.quizAttempt({
      payloadVersion: 2,
      phase: 'reviewed',
      questionSnapshot,
      contentRevision,
      answers,
      grading: { q1: { status: 'pending' } },
      results: [{ questionId: 'q1', correct: true, status: 'correct', earned: 2 }],
      gradeProvenance: {},
      submittedDigest: quizSubmittedDigest(contentRevision, answers),
    });

    expect(validation.valid).toBe(false);
  });

  it('keeps missing answer keys unavailable and grades blank short answers without AI', () => {
    const grading = createSubmittedQuizGrading(
      [
        { id: 'choice', type: 'single', question: 'Broken choice', points: 1 },
        {
          id: 'short',
          type: 'short_answer',
          question: 'Explain',
          commentPrompt: 'Use evidence',
          points: 3,
        },
      ],
      { choice: 'a', short: '   ' },
      '2026-09-14T00:00:00.000Z',
    );

    expect(grading.grading.choice).toEqual({
      status: 'unavailable',
      error: { code: 'MISSING_ANSWER_KEY', retryable: false },
    });
    expect(grading.grading.short).toMatchObject({
      status: 'graded',
      result: { questionId: 'short', earned: 0, status: 'incorrect' },
      provenance: { basis: 'blank-answer' },
    });
    expect(grading.results).toEqual([expect.objectContaining({ questionId: 'short', earned: 0 })]);
  });

  it('keeps the first persisted legal grade when a duplicate response arrives later', () => {
    const questionSnapshot = [
      {
        id: 'short',
        type: 'short_answer' as const,
        question: 'Explain',
        commentPrompt: 'Use evidence',
        points: 3,
      },
    ];
    const contentRevision = quizContentRevision(questionSnapshot);
    const answers = { short: 'Evidence' };
    const payload = {
      payloadVersion: 2 as const,
      phase: 'submitted' as const,
      questionSnapshot,
      contentRevision,
      answers,
      grading: { short: { status: 'pending' as const } },
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
      payload,
      { questionId: 'short', correct: true, status: 'correct', earned: 3 },
      provenance,
    );
    const late = applyQuizGrade(
      first,
      { questionId: 'short', correct: false, status: 'incorrect', earned: 0 },
      { ...provenance, model: 'model-b', gradedAt: '2026-09-14T00:00:10.000Z' },
    );

    expect(late).toBe(first);
    expect(late.results).toEqual([
      { questionId: 'short', correct: true, status: 'correct', earned: 3 },
    ]);
  });

  it('builds the same submission digest regardless of answer object insertion order', () => {
    expect(quizSubmittedDigest('revision', { q2: ['b'], q1: 'a' })).toBe(
      quizSubmittedDigest('revision', { q1: 'a', q2: ['b'] }),
    );
  });
});
