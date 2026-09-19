import { describe, expect, it } from 'vitest';

import {
  parseTeachBackTurnResult,
  teachBackClosingSpeech,
  type TeachBackExplanation,
  type TeachBackPlan,
  type TeachBackSource,
} from '@/lib/learning/teach-back/contracts';

const source: TeachBackSource = {
  stageId: 'stage-1',
  sceneId: 'scene-1',
  sceneType: 'slide',
  title: 'Linear equations',
  courseTitle: 'Algebra',
  snapshotAlgorithmVersion: 'learning-content-v1',
  sourceRevision: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  fragments: [
    {
      id: 'scene:scene-1',
      digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      text: 'A linear equation in two unknowns has degree 1 in each unknown.',
    },
  ],
  coverageLimited: false,
};

const plan: TeachBackPlan = {
  topic: 'Linear equations',
  criteria: [
    {
      criterionId: 'criterion-1',
      description: 'Degree of each unknown is 1',
      quote: 'degree 1 in each unknown',
      fragmentId: 'scene:scene-1',
    },
  ],
  peer: {
    id: 'default-2',
    name: 'Zhiwei',
    role: 'assistant',
    persona: 'helper',
    avatar: '/a.png',
    color: '#10b981',
  },
  openingQuestion: {
    questionId: 'question-open',
    text: 'What kind of equation is this?',
    criterionId: 'criterion-1',
  },
};

function explanation(turnIndex: number, text = '整式方程'): TeachBackExplanation {
  return {
    turnId: `turn-${turnIndex}`,
    turnIndex,
    text,
    submittedAt: '2026-09-19T00:00:00.000Z',
    questionId: 'question-open',
  };
}

describe('teach-back turn result coercion', () => {
  it('stops after a correct explanation before the third turn and keeps the affirmation', () => {
    const result = parseTeachBackTurnResult(
      {
        turnId: 'turn-1',
        extra: true,
        criteria: [
          {
            criterionId: 'criterion-1',
            status: 'explained',
            reason: 'You named the degree correctly.',
            citation: { turnId: 'turn-1', excerpt: 'not in the student text' },
          },
        ],
        nextQuestion: {
          questionId: 'q-2',
          text: 'Can you give a counterexample?',
          criterionId: 'criterion-1',
        },
        suggestion: '说得对，次数已经讲清楚了。',
      },
      plan,
      [explanation(1, '次数是1')],
      'turn-1',
    );
    expect(result.nextQuestion).toBeUndefined();
    expect(result.endReason).toBe('all_explained');
    expect(result.criteria[0]?.citation).toBeUndefined();
    expect(teachBackClosingSpeech(result, plan)).toContain('说得对');
  });

  it('keeps the third-turn affirmation and never asks a fourth question', () => {
    const result = parseTeachBackTurnResult(
      {
        turnId: 'turn-3',
        criteria: [
          {
            criterionId: 'criterion-1',
            status: 'explained',
            reason: 'Covered on the last try.',
          },
        ],
        nextQuestion: {
          questionId: 'q-4',
          text: 'What is a counterexample?',
          criterionId: 'criterion-1',
        },
        suggestion: '三次都讲对了，这一轮可以停了。',
      },
      plan,
      [explanation(1), explanation(2), explanation(3)],
      'turn-3',
    );
    expect(result.nextQuestion).toBeUndefined();
    expect(result.endReason).toBe('all_explained');
    expect(teachBackClosingSpeech(result, plan)).toContain('三次都讲对了');
  });

  it('on the third incomplete turn speaks the correct explanation instead of failing', () => {
    const result = parseTeachBackTurnResult(
      {
        turnId: 'turn-3',
        criteria: [
          {
            criterionId: 'criterion-1',
            status: 'needs_supplement',
            reason: 'Still missing the degree.',
            citation: { turnId: 'turn-3', excerpt: '整式方程' },
          },
        ],
        nextQuestion: {
          questionId: 'q-4',
          text: 'Why must the degree be 1?',
          criterionId: 'criterion-1',
        },
        endReason: null,
        suggestion: '正确说法：每个未知数的次数都是1。',
      },
      plan,
      [explanation(1), explanation(2), explanation(3)],
      'turn-3',
    );
    expect(result.nextQuestion).toBeUndefined();
    expect(result.endReason).toBe('max_turns');
    expect(result.suggestion).toContain('每个未知数的次数都是1');
  });
});
