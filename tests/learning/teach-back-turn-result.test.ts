import { describe, expect, it } from 'vitest';

import {
  parseTeachBackTurnResult,
  teachBackClosingSpeech,
  type TeachBackExplanation,
  type TeachBackPlan,
} from '@/lib/learning/teach-back/contracts';

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

const multiCriterionPlan: TeachBackPlan = {
  ...plan,
  criteria: [
    plan.criteria[0]!,
    {
      criterionId: 'criterion-2',
      description: 'Both unknowns occur only to the first power',
      quote: 'two unknowns both occur to the first power',
      fragmentId: 'scene:scene-1',
    },
    {
      criterionId: 'criterion-3',
      description: 'The equation is a polynomial equation',
      quote: 'the equation is polynomial',
      fragmentId: 'scene:scene-1',
    },
  ],
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
            citation: { turnId: 'turn-1', excerpt: '次数是1' },
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
    expect(result.criteria[0]?.citation).toEqual({ turnId: 'turn-1', excerpt: '次数是1' });
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
            citation: { turnId: 'turn-3', excerpt: '整式方程' },
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

  it('stops as soon as the current answer is correct even when other frozen criteria remain', () => {
    const result = parseTeachBackTurnResult(
      {
        turnId: 'turn-1',
        criteria: [
          {
            criterionId: 'criterion-1',
            status: 'explained',
            reason: 'The current question was answered correctly.',
            citation: { turnId: 'turn-1', excerpt: '次数是1' },
          },
          {
            criterionId: 'criterion-2',
            status: 'not_addressed',
            reason: 'Not asked yet.',
          },
          {
            criterionId: 'criterion-3',
            status: 'not_addressed',
            reason: 'Not asked yet.',
          },
        ],
        nextQuestion: {
          questionId: 'q-2',
          text: 'What about the other condition?',
          criterionId: 'criterion-2',
        },
        suggestion: 'That answer is correct.',
      },
      multiCriterionPlan,
      [explanation(1, '次数是1')],
      'turn-1',
    );
    expect(result.endReason).toBe('answer_correct');
    expect(result.nextQuestion).toBeUndefined();
  });

  it('does not mistake a historical correct citation for a correct current answer', () => {
    const result = parseTeachBackTurnResult(
      {
        turnId: 'turn-2',
        criteria: [
          {
            criterionId: 'criterion-1',
            status: 'explained',
            reason: 'This was established in the previous answer.',
            citation: { turnId: 'turn-1', excerpt: '次数是1' },
          },
          {
            criterionId: 'criterion-2',
            status: 'needs_supplement',
            reason: 'The current answer does not explain both unknowns.',
            citation: { turnId: 'turn-2', excerpt: '我不知道' },
          },
          {
            criterionId: 'criterion-3',
            status: 'not_addressed',
            reason: 'Not addressed yet.',
          },
        ],
        nextQuestion: {
          questionId: 'q-3',
          text: '两个未知数的次数需要满足什么条件？',
          criterionId: 'criterion-2',
        },
        suggestion: '这次还需要补充。',
      },
      multiCriterionPlan,
      [explanation(1, '次数是1'), explanation(2, '我不知道')],
      'turn-2',
    );
    expect(result.endReason).toBeUndefined();
    expect(result.nextQuestion?.criterionId).toBe('criterion-2');
  });

  it('treats a historical correct citation plus a wrong third answer as max turns', () => {
    const result = parseTeachBackTurnResult(
      {
        turnId: 'turn-3',
        criteria: [
          {
            criterionId: 'criterion-1',
            status: 'explained',
            reason: 'This was established in the first answer.',
            citation: { turnId: 'turn-1', excerpt: '次数是1' },
          },
          {
            criterionId: 'criterion-2',
            status: 'needs_supplement',
            reason: 'The current answer is incorrect.',
            citation: { turnId: 'turn-3', excerpt: '还是不知道' },
          },
          {
            criterionId: 'criterion-3',
            status: 'not_addressed',
            reason: 'Not addressed.',
          },
        ],
        suggestion: '再想想。',
      },
      multiCriterionPlan,
      [explanation(1, '次数是1'), explanation(2, '我不知道'), explanation(3, '还是不知道')],
      'turn-3',
    );
    expect(result.endReason).toBe('max_turns');
    expect(result.nextQuestion).toBeUndefined();
    expect(result.suggestion).toContain('two unknowns both occur to the first power');
  });

  it('adds deterministic affirmation when a correct result has generic model feedback', () => {
    const result = parseTeachBackTurnResult(
      {
        turnId: 'turn-1',
        criteria: [
          {
            criterionId: 'criterion-1',
            status: 'explained',
            reason: 'The answer is correct.',
            citation: { turnId: 'turn-1', excerpt: '次数是1' },
          },
        ],
        suggestion: '继续努力。',
      },
      plan,
      [explanation(1, '次数是1')],
      'turn-1',
    );
    expect(result.suggestion).toContain('回答正确');
    expect(result.endReason).toBe('all_explained');
  });

  it('localizes deterministic affirmation instead of leaking the default locale', () => {
    const result = parseTeachBackTurnResult(
      {
        turnId: 'turn-1',
        criteria: [
          {
            criterionId: 'criterion-1',
            status: 'explained',
            reason: 'The answer is correct.',
            citation: { turnId: 'turn-1', excerpt: 'The degree is one.' },
          },
        ],
        suggestion: 'Keep going.',
      },
      plan,
      [explanation(1, 'The degree is one.')],
      'turn-1',
      'en-US',
    );
    expect(result.suggestion).toContain('Correct');
    expect(result.suggestion).not.toContain('回答正确');
  });

  it('grounds the third incorrect closing in the frozen course explanation', () => {
    const result = parseTeachBackTurnResult(
      {
        turnId: 'turn-3',
        criteria: [
          {
            criterionId: 'criterion-1',
            status: 'not_addressed',
            reason: 'The defining condition is still missing.',
          },
        ],
        suggestion: '继续努力。',
      },
      plan,
      [explanation(1), explanation(2), explanation(3)],
      'turn-3',
    );
    expect(result.endReason).toBe('max_turns');
    expect(result.nextQuestion).toBeUndefined();
    expect(result.suggestion).toContain('degree 1 in each unknown');
  });

  it('keeps every frozen course answer in a multi-criterion third-turn correction', () => {
    const longUntrustedReason = `错误模型理由${'错'.repeat(290)}`;
    const result = parseTeachBackTurnResult(
      {
        turnId: 'turn-3',
        criteria: multiCriterionPlan.criteria.map((criterion) => ({
          criterionId: criterion.criterionId,
          status: 'not_addressed',
          reason: longUntrustedReason,
        })),
        suggestion: '继续努力。',
      },
      multiCriterionPlan,
      [explanation(1), explanation(2), explanation(3)],
      'turn-3',
    );
    expect(result.suggestion).toContain('degree 1 in each unknown');
    expect(result.suggestion).toContain('two unknowns both occur to the first power');
    expect(result.suggestion).toContain('the equation is polynomial');
    expect(result.suggestion).not.toContain(longUntrustedReason);
  });
});
