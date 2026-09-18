import { describe, expect, it } from 'vitest';

import { validateLearningQuestionSet } from '@/lib/learning/contracts';
import { learningPayload } from './fixtures';

describe('learning-check question-set contract', () => {
  it.each([
    [
      'duplicate question ids',
      (questions: ReturnType<typeof learningPayload>['questionSet']['questions']) => [
        questions[0],
        { ...questions[0] },
      ],
    ],
    [
      'duplicate option values',
      (questions: ReturnType<typeof learningPayload>['questionSet']['questions']) => [
        {
          ...questions[0],
          options: [questions[0]!.options![0]!, { label: 'Also motion', value: 'A' }],
        },
      ],
    ],
    [
      'duplicate correct answers',
      (questions: ReturnType<typeof learningPayload>['questionSet']['questions']) => [
        { ...questions[0], correctAnswer: ['A', 'A'] },
      ],
    ],
    [
      'multiple correct answers for a single-choice question',
      (questions: ReturnType<typeof learningPayload>['questionSet']['questions']) => [
        { ...questions[0], correctAnswer: ['A', 'B'] },
      ],
    ],
  ])('rejects %s', (_label, mutateQuestions) => {
    const valid = learningPayload().questionSet;
    expect(
      validateLearningQuestionSet({ ...valid, questions: mutateQuestions(valid.questions) }),
    ).toBe(false);
  });
});
