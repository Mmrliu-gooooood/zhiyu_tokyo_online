/**
 * AI practice rules (learning plan B11), pure: planning batches and call
 * caps; the program checks of a generation reply (count, types, validity,
 * answer key, knowledge points, citations, exact and near repeats); review
 * parsing; independent checks; and how practice answers reach the
 * wrong-answer book and the learning record.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import type { AttemptGrading } from '@/lib/study/assessments/contracts';
import { examEvents } from '@/lib/study/memory/projection';
import {
  assistanceLevel,
  callCapFor,
  isIndependentPass,
  nextBatch,
  remainingTargets,
  type PracticeEvidence,
  type ProducedQuestion,
} from '@/lib/study/practice/contracts';
import {
  buildGenerationMessage,
  checkGeneration,
  generationSystemPrompt,
  isSingleExpression,
  parseJsonObject,
  parseReview,
  stemSimilarity,
  type CheckOptions,
} from '@/lib/study/practice/generation';
import { canonicalQuestionText, type QuestionContent } from '@/lib/study/questions/contracts';
import { examEntries, examQuestionKey } from '@/lib/study/wrongbook/projection';

const hash = (content: QuestionContent) =>
  createHash('sha256').update(canonicalQuestionText(content)).digest('hex');

const EVIDENCE: PracticeEvidence[] = [
  { id: 'E1', kind: 'material', text: '导数是瞬时变化率。' },
  { id: 'E2', kind: 'material', text: '切线斜率等于导数。' },
];

function options(overrides: Partial<CheckOptions> = {}): CheckOptions {
  return {
    batch: [{ type: 'single', count: 2 }],
    evidence: EVIDENCE,
    concepts: [],
    fixedConcepts: null,
    subtype: null,
    duplicates: { hashes: new Set(), stems: [], original: null },
    hash,
    batchNo: 1,
    ...overrides,
  };
}

const single = (stem: string, extra: Record<string, unknown> = {}) => ({
  type: 'single',
  stem,
  options: [
    { value: 'A', label: '对的' },
    { value: 'B', label: '错的' },
  ],
  answer: ['A'],
  explanation: '因为定义。',
  hint: '回忆定义。',
  concepts: ['导数'],
  refs: ['E1'],
  ...extra,
});

const reply = (questions: unknown[]) => JSON.stringify({ questions });

function produced(type: 'single' | 'short_answer'): ProducedQuestion {
  return {
    questionId: 'q-x',
    version: 1,
    type,
    stem: 's',
    concepts: [],
    refs: ['E1'],
    hint: null,
    similarity: null,
    review: '',
    batch: 1,
  };
}

describe('planning', () => {
  it('caps calls per batch and writes what is left in batches of five', () => {
    expect(callCapFor(2)).toBe(3);
    expect(callCapFor(5)).toBe(3);
    expect(callCapFor(6)).toBe(6);
    expect(callCapFor(20)).toBe(12);
    const targets = [
      { type: 'single' as const, count: 4 },
      { type: 'short_answer' as const, count: 3 },
    ];
    expect(nextBatch(targets, [])).toEqual([
      { type: 'single', count: 4 },
      { type: 'short_answer', count: 1 },
    ]);
    const done = [produced('single'), produced('single'), produced('single'), produced('single')];
    expect(remainingTargets(targets, done)).toEqual([{ type: 'short_answer', count: 3 }]);
    expect(nextBatch(targets, [...done, produced('short_answer')])).toEqual([
      { type: 'short_answer', count: 2 },
    ]);
  });

  it('puts the request and evidence into the message as data, and states the variant rule', () => {
    const message = buildGenerationMessage(
      {
        spaceName: '高数',
        courseTitle: '导数入门',
        difficulty: 'harder',
        concepts: ['导数'],
        subtype: null,
        variant: false,
      },
      [{ type: 'single', count: 2 }],
      EVIDENCE,
      ['已有的题'],
    );
    const data = JSON.parse(
      message.slice(message.indexOf('<data>') + 6, message.indexOf('</data>')),
    );
    expect(data).toMatchObject({
      subject: '高数',
      course: '导数入门',
      request: [{ type: 'single', count: 2 }],
      difficulty: '偏难',
      concepts: ['导数'],
      avoid: ['已有的题'],
    });
    expect(data.evidence.map((piece: { id: string }) => piece.id)).toEqual(['E1', 'E2']);
    expect(generationSystemPrompt(true)).toContain('原题 Q0 的变式');
    expect(generationSystemPrompt(false)).not.toContain('Q0');
  });
});

describe('program checks', () => {
  it('accepts well-formed questions, fenced or bare, with their hint and citations', () => {
    const result = checkGeneration(
      '```json\n' +
        reply([single('导数的定义是什么？'), single('切线的斜率等于什么？', { refs: ['E2'] })]) +
        '\n```',
      options(),
    );
    expect(result.parsed).toBe(true);
    expect(result.rejected).toEqual([]);
    expect(
      result.accepted.map((candidate) => [candidate.content.stem, candidate.refs, candidate.hint]),
    ).toEqual([
      ['导数的定义是什么？', ['E1'], '回忆定义。'],
      ['切线的斜率等于什么？', ['E2'], '回忆定义。'],
    ]);
    expect(result.accepted[0]!.content.source).toBeNull();
  });

  it('rejects the whole reply when it has more questions than asked', () => {
    const result = checkGeneration(reply([single('一'), single('二'), single('三')]), options());
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([
      { batch: 1, stage: 'output', reason: 'too_many', note: '3/2' },
    ]);
  });

  it('reports output that is not JSON', () => {
    expect(checkGeneration('好的，下面是题目：', options())).toMatchObject({
      parsed: false,
      rejected: [{ stage: 'output', reason: 'not_json' }],
    });
    expect(parseJsonObject('说明：{"questions":[]} 完')).toEqual({ questions: [] });
  });

  it('drops wrong types, extras, invalid content, missing keys and bad citations', () => {
    const result = checkGeneration(
      reply([
        single('不该有的简答', { type: 'short_answer', referenceAnswer: '略' }),
        single('选项重复', {
          options: [
            { value: 'A', label: '一样' },
            { value: 'B', label: '一样' },
          ],
        }),
        single('没有答案', { answer: [] }),
        single('引用不存在的资料', { refs: ['E7'] }),
        single('没有引用', { refs: [] }),
      ]).replace(/^/, ''),
      options({ batch: [{ type: 'single', count: 5 }] }),
    );
    expect(result.accepted).toEqual([]);
    expect(result.rejected.map((entry) => entry.reason)).toEqual([
      'type_unrequested',
      'invalid',
      'no_answer_key',
      'bad_refs',
      'bad_refs',
    ]);
    const extra = checkGeneration(
      reply([single('第一道'), single('不同的第二道')]),
      options({
        batch: [
          { type: 'single', count: 1 },
          { type: 'multiple', count: 1 },
        ],
      }),
    );
    expect(extra.accepted).toHaveLength(1);
    expect(extra.rejected.map((entry) => entry.reason)).toEqual(['type_excess']);
  });

  it('keeps knowledge points to the allowed list, and variants to the original ones', () => {
    const allowed = checkGeneration(
      reply([
        single('属于导数', { concepts: ['导数', '无关'] }),
        single('都不属于', { concepts: ['积分'] }),
      ]),
      options({ concepts: ['导数'] }),
    );
    expect(allowed.accepted.map((candidate) => candidate.content.concepts)).toEqual([['导数']]);
    expect(allowed.rejected.map((entry) => entry.reason)).toEqual(['concept_missing']);
    const variant = checkGeneration(reply([single('变式一', { concepts: ['随便'] })]), {
      ...options({ batch: [{ type: 'single', count: 1 }] }),
      fixedConcepts: ['切线'],
    });
    expect(variant.accepted[0]!.content.concepts).toEqual(['切线']);
  });

  it('accepts open questions with a reference answer and adds up their scoring points', () => {
    const result = checkGeneration(
      reply([
        {
          type: 'short_answer',
          subtype: 'calculation',
          stem: '求 $x^2$ 在 $x=3$ 处的导数。',
          referenceAnswer: '$2x$ 代入得 6。',
          finalAnswer: '6',
          rubric: [
            { text: '写出导函数', points: 2 },
            { text: '代入求值', points: 1 },
          ],
          points: 5,
          refs: ['E1'],
        },
        { type: 'short_answer', stem: '没有参考答案的简答。', refs: ['E1'] },
      ]),
      options({ batch: [{ type: 'short_answer', count: 2 }] }),
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]!.content).toMatchObject({
      type: 'short_answer',
      subtype: 'calculation',
      points: 3,
      guide: { finalAnswer: '6', referenceAnswer: '$2x$ 代入得 6。' },
    });
    expect(result.rejected.map((entry) => entry.reason)).toEqual(['no_answer_key']);
    // Variants keep the original's kind of open question.
    const variant = checkGeneration(
      reply([
        {
          type: 'short_answer',
          subtype: 'proof',
          stem: '说明理由。',
          referenceAnswer: '因为……',
          refs: ['E1'],
        },
      ]),
      options({ batch: [{ type: 'short_answer', count: 1 }], subtype: 'short' }),
    );
    expect(variant.accepted[0]!.content.subtype).toBe('short');
  });

  it('keeps a final answer only when it is one number or expression', () => {
    expect(isSingleExpression('6')).toBe(true);
    expect(isSingleExpression('$\\frac{1}{2}$')).toBe(true);
    expect(isSingleExpression('y=2x')).toBe(true);
    expect(isSingleExpression('极大值 $f(-1)=2$，极小值 $f(1)=-2$')).toBe(false);
    expect(isSingleExpression('$y=2x$; $x=1$')).toBe(false);
    expect(isSingleExpression('$a=1$, $b=2$')).toBe(false);
    const result = checkGeneration(
      reply([
        {
          type: 'short_answer',
          subtype: 'calculation',
          stem: '求 $f(x)=x^3-3x$ 的极值。',
          referenceAnswer: '极大值 $f(-1)=2$，极小值 $f(1)=-2$。',
          finalAnswer: '极大值 $f(-1)=2$，极小值 $f(1)=-2$',
          rubric: [
            { text: '求出导数', points: 2 },
            { final: true, points: 2 },
          ],
          refs: ['E1'],
        },
      ]),
      options({ batch: [{ type: 'short_answer', count: 1 }] }),
    );
    expect(result.rejected).toEqual([]);
    expect(result.accepted[0]!.content.guide).toMatchObject({
      finalAnswer: null,
      rubric: [
        { text: '求出导数', points: 2 },
        { text: '最终结果正确', points: 2 },
      ],
    });
    expect(result.accepted[0]!.content.guide!.rubric.some((point) => point.final)).toBe(false);
  });

  it('rejects exact repeats and near repeats, and records similarity', () => {
    const bankQuestion = single('导数的定义是什么？');
    const parsedBank = checkGeneration(
      reply([bankQuestion]),
      options({ batch: [{ type: 'single', count: 1 }] }),
    ).accepted[0]!.content;
    const result = checkGeneration(
      reply([
        bankQuestion,
        single('导数的 定义，是什么。', {
          options: [
            { value: 'A', label: '甲' },
            { value: 'B', label: '乙' },
          ],
        }),
        single('一个物体的位移函数是三次函数，求某时刻的速度。'),
        single('一个物体的位移函数是三次函数，求某时刻的加速度。'),
      ]),
      options({
        batch: [{ type: 'single', count: 4 }],
        duplicates: {
          hashes: new Set([hash(parsedBank)]),
          stems: [{ questionId: 'q-bank', stem: '导数的定义是什么？' }],
          original: null,
        },
      }),
    );
    expect(result.rejected.map((entry) => entry.reason)).toEqual(['duplicate', 'near_duplicate']);
    expect(result.accepted).toHaveLength(2);
    expect(result.accepted[1]!.similarity).toMatchObject({ original: false, questionId: null });
    expect(result.accepted[1]!.similarity!.score).toBeGreaterThan(0.6);
    expect(stemSimilarity('完全不同的内容', '导数定义')).toBeLessThan(0.2);
    expect(stemSimilarity('ＡＢＣ  12', 'abc12')).toBe(1);
  });

  it('refuses a variant that copies the original', () => {
    const result = checkGeneration(
      reply([
        single('原题：求导数。', {
          options: [
            { value: 'A', label: '新' },
            { value: 'B', label: '旧' },
          ],
        }),
      ]),
      options({
        batch: [{ type: 'single', count: 1 }],
        duplicates: {
          hashes: new Set(),
          stems: [],
          original: { hash: 'h', stem: '原题：求导数。' },
        },
      }),
    );
    expect(result.rejected).toEqual([
      expect.objectContaining({ reason: 'near_duplicate', note: '1' }),
    ]);
  });
});

describe('review', () => {
  it('keeps only verdicts for known ids; anything else is missing', () => {
    const verdicts = parseReview(
      JSON.stringify({
        reviews: [
          { id: 'n1', status: 'passed', notes: '正确' },
          { id: 'n2', status: 'rejected', notes: ['答案错', '无依据'] },
          { id: 'n3', status: 'maybe' },
          { id: 'zz', status: 'passed' },
        ],
      }),
      new Set(['n1', 'n2', 'n3']),
    );
    expect([...verdicts!.entries()]).toEqual([
      ['n1', { status: 'passed', notes: '正确' }],
      ['n2', { status: 'rejected', notes: '答案错；无依据' }],
    ]);
    expect(parseReview('没问题', new Set(['n1']))).toBeNull();
  });
});

describe('independent checks', () => {
  it('counts only a new question answered right without help', () => {
    expect(isIndependentPass('correct', { novelty: 'new' })).toBe(true);
    expect(isIndependentPass('correct', { novelty: 'seen' })).toBe(false);
    expect(isIndependentPass('correct', { novelty: 'new', hintAt: 't' })).toBe(false);
    expect(isIndependentPass('correct', { novelty: 'new', solutionAt: 't' })).toBe(false);
    expect(isIndependentPass('partial', { novelty: 'new' })).toBe(false);
    expect(isIndependentPass('correct', undefined)).toBe(false);
    expect(assistanceLevel({ hintAt: 't', solutionAt: 't' })).toBe('solution_seen');
  });
});

describe('practice answers in the wrong-answer book and the learning record', () => {
  const grading: AttemptGrading = {
    version: 'objective-v1',
    items: [
      { position: 1, outcome: 'correct', earned: 1, points: 1 },
      { position: 2, outcome: 'incorrect', earned: 0, points: 1 },
    ],
    earned: 1,
    totalPoints: 2,
    correct: 1,
    unanswered: 0,
    ungradable: 0,
  };
  const item = (position: number, family: boolean) => ({
    position,
    type: 'single' as const,
    stem: `变式 ${position}`,
    options: [
      { value: 'A', label: '甲' },
      { value: 'B', label: '乙' },
    ],
    points: 1,
    concepts: ['导数'],
    figures: [],
    source: {
      origin: 'ai_generated' as const,
      verification: 'unverified' as const,
      generation: {
        jobId: 'pj-1',
        model: 'deepseek:deepseek-flash',
        review: 'ai_reviewed' as const,
        refs: [],
        ...(family ? { family: { questionKey: 'quiz:stage-a:quiz:q1', wrongItemId: 'wi-1' } } : {}),
      },
    },
    answer: ['A'],
    explanation: null,
    guide: null,
    questionId: `q-${position}`,
    packQuestion: null,
    contentHash: `h${position}`,
  });

  it('joins a variant to the question it varies and records novelty and help', () => {
    expect(examQuestionKey(item(1, true))).toBe('quiz:stage-a:quiz:q1');
    expect(examQuestionKey(item(1, false))).toBe('bank:q-1');
    const entries = examEntries({
      attemptId: 'att-1',
      paperId: 'paper-1',
      paperTitle: '变式练习',
      submittedAt: '2026-10-18T00:00:00.000Z',
      answers: { '1': ['A'], '2': ['B'] },
      grading,
      gradings: new Map(),
      items: [item(1, true), item(2, true)],
      assistance: { items: { '1': { novelty: 'new' }, '2': { novelty: 'new', hintAt: 't' } } },
    });
    expect(
      entries.map((entry) => [entry.questionKey, entry.outcome, entry.origin.practice]),
    ).toEqual([
      [
        'quiz:stage-a:quiz:q1',
        'correct',
        { novelty: 'new', assistance: 'unassisted', variant: true, independent: true },
      ],
      [
        'quiz:stage-a:quiz:q1',
        'incorrect',
        { novelty: 'new', assistance: 'hinted', variant: true, independent: false },
      ],
    ]);
    // Earlier papers (no record, no variant) keep their entries unchanged.
    const plain = examEntries({
      attemptId: 'att-0',
      paperId: 'paper-0',
      paperTitle: '旧卷',
      submittedAt: '2026-10-01T00:00:00.000Z',
      answers: { '2': ['B'] },
      grading,
      gradings: new Map(),
      items: [item(2, false)],
    });
    expect(plain[0]!.origin.practice).toBeUndefined();
  });

  it('records each help shown and the practice counts of a paper', () => {
    const events = examEvents([
      {
        attemptId: 'att-1',
        paperId: 'paper-1',
        spaceId: 'space-a',
        submittedAt: '2026-10-18T00:10:00.000Z',
        itemCount: 2,
        correct: 1,
        unanswered: 0,
        earned: 1,
        totalPoints: 2,
        openItems: 0,
        independence: { independent: 1, helped: 1, repeated: 0 },
        help: [{ position: 2, level: 1, at: '2026-10-18T00:05:00.000Z' }],
      },
    ]);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'exam_graded',
        sourceKey: 'exam:att-1:graded',
        payload: expect.objectContaining({
          independence: { independent: 1, helped: 1, repeated: 0 },
        }),
      }),
      {
        type: 'hint_used',
        payloadVersion: 1,
        sourceType: 'exam_attempt',
        sourceId: 'att-1',
        sourceKey: 'exam:att-1:help:2:1',
        stageId: null,
        spaceId: 'space-a',
        occurredAt: '2026-10-18T00:05:00.000Z',
        payload: { contextKind: 'exam_item', contextId: 'att-1:2', level: 1 },
      },
    ]);
  });
});
