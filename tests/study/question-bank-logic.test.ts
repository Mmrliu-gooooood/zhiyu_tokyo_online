/**
 * Question bank, rule-based paper building and objective grading (learning
 * plan B07): import validation with located errors, duplicate keys,
 * deterministic selection with shortfalls instead of padding, and grading
 * that never treats an empty key as matching an empty answer.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  canonicalAnswers,
  gradeAttempt,
  gradeItem,
  isUsableKey,
  parseAnswers,
  toItemView,
} from '@/lib/study/assessments/contracts';
import {
  parseBlueprint,
  selectQuestions,
  type BlueprintCandidate,
  type ExamBlueprint,
} from '@/lib/study/questions/blueprint';
import {
  blockingIssues,
  canonicalQuestionText,
  conceptKey,
  isGradable,
  parseImportDocument,
  parseQuestion,
  validateQuestionContent,
} from '@/lib/study/questions/contracts';
import { OFFICIAL_PACKS, packQuestionContent } from '@/lib/study/questions/packs';
import { renderQuizMathText } from '@/lib/quiz/math-text';

const codes = (issues: { code: string; path: string }[]) =>
  issues.map((issue) => `${issue.path}:${issue.code}`);

describe('import parsing', () => {
  it('drops characters Postgres cannot store in jsonb', () => {
    const parsed = parseQuestion({
      type: 'single',
      stem: '1\u0000+1\u0001=?\r\n\t第二行\uDC00',
      options: ['1\u0000', '2'],
      answer: 'B',
      explanation: 'x\u0000',
    });
    expect(parsed.content).toMatchObject({
      stem: '1+1 =?\n\t第二行�',
      options: [
        { value: 'A', label: '1' },
        { value: 'B', label: '2' },
      ],
      explanation: 'x',
    });
  });

  it('accepts the documented spellings of options and answers', () => {
    const strings = parseQuestion({
      type: 'single',
      stem: ' 1＋1 等于多少？（填写） ',
      options: ['1', '2', '3'],
      answer: 'ｂ',
      concepts: ['加法', ' 加法 ', 'ＡＢ', 'ab'],
      verified: true,
    });
    expect(strings.issues).toEqual([]);
    expect(strings.content).toMatchObject({
      stem: '1＋1 等于多少？（填写）',
      options: [
        { value: 'A', label: '1' },
        { value: 'B', label: '2' },
        { value: 'C', label: '3' },
      ],
      answer: ['B'],
      concepts: ['加法', 'ＡＢ'],
      points: 1,
    });
    expect(strings.verified).toBe(true);

    const keyed = parseQuestion({
      type: 'multiple_choice',
      question: 'Pick primes',
      options: { a: 'two', b: 'three', c: 'four' },
      answer: 'a,b',
    });
    expect(keyed.content).toMatchObject({ type: 'multiple', answer: ['A', 'B'] });
    expect(keyed.issues).toEqual([]);

    const objects = parseQuestion({
      type: 'multiple',
      stem: 'x',
      options: [
        { key: 'A', text: 'p' },
        { value: 'B', label: 'q' },
      ],
      answer: 'AB',
    });
    expect(objects.content?.answer).toEqual(['A', 'B']);
  });

  it('locates every problem in a question', () => {
    const bad = parseQuestion({
      type: 'single',
      stem: '',
      options: ['same', 'same', ''],
      answer: ['A', 'D'],
      difficulty: 9,
      points: 0,
      source: { url: 'ftp://x' },
    });
    expect(codes(bad.issues)).toEqual(
      expect.arrayContaining([
        'stem:stem_missing',
        'options[2].label:option_empty',
        'options[1]:option_duplicate',
        'answer:answer_not_in_options',
        'answer:answer_single_needs_one',
        'difficulty:difficulty_invalid',
        'points:points_invalid',
        'source.url:source_invalid',
      ]),
    );
    expect(codes(parseQuestion({ type: 'essay_long', stem: 'x' }).issues)).toContain(
      'type:type_unsupported',
    );
    expect(parseQuestion('nope').issues).toEqual([{ path: '', code: 'not_object' }]);
  });

  it('keeps a question without an answer as a draft, never as gradable', () => {
    const draft = parseQuestion({ type: 'single', stem: 'x', options: ['a', 'b'] });
    expect(codes(draft.issues)).toEqual(['answer:answer_missing']);
    expect(blockingIssues(draft.issues)).toEqual([]);
    expect(isGradable(draft.content!)).toBe(false);
  });

  it('reads a whole file and rejects other shapes', () => {
    const file = parseImportDocument({
      format: 'zhiyu-question-bank',
      version: 1,
      source: { title: '习题册', license: '自有' },
      questions: [
        { type: 'single', stem: 'a', options: ['x', 'y'], answer: 'A' },
        { type: 'single', stem: 'b', options: ['x', 'y'], answer: 'B', source: { page: 12 } },
      ],
    });
    expect(file.fileError).toBeNull();
    expect(file.items[0]!.content!.source).toEqual({ title: '习题册', license: '自有' });
    expect(file.items[1]!.content!.source).toEqual({ page: '12' });
    expect(parseImportDocument({ format: 'gift', questions: [] }).fileError).toBe(
      'not_question_bank',
    );
    expect(parseImportDocument([]).fileError).toBe('empty');
    expect(parseImportDocument(Array.from({ length: 501 }, () => ({}))).fileError).toBe(
      'too_many_questions',
    );
  });

  it('identifies a question by type, stem, options and key only', () => {
    const base = parseQuestion({
      type: 'single',
      stem: 'Ａ  b',
      options: ['x', 'y'],
      answer: 'A',
    }).content!;
    const same = { ...base, stem: 'a b', explanation: 'why', concepts: ['k'], points: 3 };
    expect(canonicalQuestionText(same)).toBe(canonicalQuestionText(base));
    expect(canonicalQuestionText({ ...base, answer: ['B'] })).not.toBe(canonicalQuestionText(base));
    expect(conceptKey(' 导数  应用 ')).toBe('导数 应用');
  });
});

describe('the public sample file', () => {
  it('parses: three ready questions in every spelling, one draft without an answer, three open ones', () => {
    const file = parseImportDocument(
      JSON.parse(readFileSync('public/examples/zhiyu-question-bank-sample.json', 'utf8')),
    );
    expect(file.fileError).toBeNull();
    expect(file.items.map((item) => item.issues)).toEqual([
      [],
      [],
      [],
      [{ path: 'answer', code: 'answer_missing' }],
      [],
      [],
      [],
    ]);
    expect(file.items.map((item) => item.content?.answer)).toEqual([
      ['A'],
      ['A', 'B'],
      ['A'],
      [],
      [],
      [],
      [],
    ]);
    expect(file.items.slice(4).map((item) => [item.content?.type, item.content?.subtype])).toEqual([
      ['short_answer', 'calculation'],
      ['short_answer', 'calculation'],
      ['short_answer', 'proof'],
    ]);
    expect(file.items[5]!.content!.guide).toEqual({
      referenceAnswer: null,
      finalAnswer: '-1',
      rubric: [],
    });
    expect(file.items[0]!.content!.source).toEqual({ title: '练习册第 1 章', page: '12' });
    expect(file.items[1]!.content!.source).toMatchObject({ title: '我的线性代数练习册' });
  });
});

describe('official packs', () => {
  it('ships only complete, consistent questions with attribution and licence', () => {
    for (const pack of OFFICIAL_PACKS) {
      expect(pack.attribution && pack.license).toBeTruthy();
      const ids = new Set(pack.questions.map((question) => question.id));
      expect(ids.size).toBe(pack.questions.length);
      for (const question of pack.questions) {
        const content = packQuestionContent(pack, question);
        expect(validateQuestionContent(content), question.id).toEqual([]);
        // Every formula renders on the bank pages: no raw `$` is left as text.
        for (const text of [
          content.stem,
          ...content.options.map((option) => option.label),
          content.explanation ?? '',
        ]) {
          const leftover = renderQuizMathText(text, { trustDelimiters: true })
            .filter((segment) => segment.type === 'text')
            .map((segment) => segment.value)
            .join('');
          expect(leftover, `${question.id}: ${text}`).not.toContain('$');
        }
        expect(content.source?.pack).toEqual({
          id: pack.id,
          version: pack.version,
          questionId: question.id,
        });
      }
    }
  });
});

function candidate(ref: string, overrides: Partial<BlueprintCandidate> = {}): BlueprintCandidate {
  return {
    ref,
    tier: 'bank',
    type: 'single',
    conceptKeys: [],
    stageId: null,
    difficulty: null,
    verified: true,
    seen: false,
    ...overrides,
  };
}

const blueprint = (overrides: Partial<ExamBlueprint> = {}): ExamBlueprint => ({
  spaceId: 'space-a',
  sections: [{ type: 'single', count: 3 }],
  conceptIds: [],
  stageId: null,
  difficulty: 'any',
  avoidSeen: false,
  includeUnverified: false,
  includePublic: true,
  packIds: [],
  seed: 'seed-1',
  ...overrides,
});

describe('paper building', () => {
  const bank = Array.from({ length: 6 }, (_, index) => candidate(`bank:q${index}`));

  it('is deterministic for a seed and varies across seeds', () => {
    const first = selectQuestions(blueprint(), bank, []).picked.map((item) => item.ref);
    expect(selectQuestions(blueprint(), bank, []).picked.map((item) => item.ref)).toEqual(first);
    const others = ['s2', 's3', 's4', 's5'].map((seed) =>
      selectQuestions(blueprint({ seed }), bank, [])
        .picked.map((item) => item.ref)
        .join(),
    );
    expect(new Set([first.join(), ...others]).size).toBeGreaterThan(1);
  });

  it('uses the own bank before official packs', () => {
    const pool = [
      candidate('pack:1', { tier: 'pack' }),
      candidate('pack:2', { tier: 'pack' }),
      candidate('bank:a'),
      candidate('bank:b'),
    ];
    const refs = selectQuestions(blueprint(), pool, []).picked.map((item) => item.ref);
    expect(refs.slice(0, 2).sort()).toEqual(['bank:a', 'bank:b']);
    expect(refs[2]).toMatch(/^pack:/);
  });

  it('reports shortfalls with the reasons instead of padding', () => {
    const pool = [
      candidate('bank:a'),
      candidate('bank:seen', { seen: true }),
      candidate('bank:draft', { verified: false }),
      candidate('bank:m', { type: 'multiple' }),
    ];
    const result = selectQuestions(
      blueprint({ avoidSeen: true, sections: [{ type: 'single', count: 3 }] }),
      pool,
      [],
    );
    expect(result.picked.map((item) => item.ref)).toEqual(['bank:a']);
    expect(result.shortfalls).toEqual([
      { type: 'single', wanted: 3, available: 1, excludedSeen: 1, excludedUnverified: 1 },
    ]);
    const relaxed = selectQuestions(
      blueprint({ includeUnverified: true, sections: [{ type: 'single', count: 3 }] }),
      pool,
      [],
    );
    expect(relaxed.shortfalls).toEqual([]);
  });

  it('covers every chosen knowledge point before repeating one, and reports uncovered ones', () => {
    const pool = [
      candidate('bank:l1', { conceptKeys: ['极限'] }),
      candidate('bank:l2', { conceptKeys: ['极限'] }),
      candidate('bank:l3', { conceptKeys: ['极限'] }),
      candidate('bank:d1', { conceptKeys: ['导数'] }),
      candidate('bank:x', { conceptKeys: ['积分'] }),
    ];
    const result = selectQuestions(blueprint({ sections: [{ type: 'single', count: 3 }] }), pool, [
      '极限',
      '导数',
      '概率',
    ]);
    const refs = result.picked.map((item) => item.ref);
    expect(refs).toContain('bank:d1');
    expect(refs).not.toContain('bank:x');
    expect(refs.filter((ref) => ref.startsWith('bank:l'))).toHaveLength(2);
    expect(result.uncoveredConcepts).toEqual(['概率']);
  });

  it('limits to a course and prefers the requested difficulty', () => {
    const pool = [
      candidate('bank:hard', { difficulty: 5, stageId: 'stage-a' }),
      candidate('bank:easy', { difficulty: 1, stageId: 'stage-a' }),
      candidate('bank:other', { difficulty: 1, stageId: 'stage-b' }),
    ];
    const easier = selectQuestions(
      blueprint({
        stageId: 'stage-a',
        difficulty: 'easier',
        sections: [{ type: 'single', count: 1 }],
      }),
      pool,
      [],
    );
    expect(easier.picked.map((item) => item.ref)).toEqual(['bank:easy']);
    const harder = selectQuestions(
      blueprint({
        stageId: 'stage-a',
        difficulty: 'harder',
        sections: [{ type: 'single', count: 1 }],
      }),
      pool,
      [],
    );
    expect(harder.picked.map((item) => item.ref)).toEqual(['bank:hard']);
  });

  it('validates blueprints', () => {
    expect(
      parseBlueprint({ spaceId: 's', sections: [{ type: 'single', count: 2 }] }),
    ).toMatchObject({
      ok: true,
      blueprint: { seed: null, avoidSeen: false, difficulty: 'any' },
    });
    expect(parseBlueprint({ spaceId: 's', sections: [] })).toEqual({
      ok: false,
      field: 'sections',
    });
    expect(
      parseBlueprint({
        spaceId: 's',
        sections: [
          { type: 'single', count: 1 },
          { type: 'single', count: 1 },
        ],
      }),
    ).toEqual({ ok: false, field: 'sections' });
    // Open-question sections only while assisted grading is on (B09).
    expect(
      parseBlueprint(
        { spaceId: 's', sections: [{ type: 'short_answer', count: 1 }] },
        { allowOpen: false },
      ),
    ).toEqual({ ok: false, field: 'sections' });
    expect(
      parseBlueprint({ spaceId: 's', sections: [{ type: 'short_answer', count: 1 }] }),
    ).toMatchObject({ ok: true });
    expect(
      parseBlueprint({ spaceId: 's', sections: [{ type: 'single', count: 1 }], seed: 'a b' }),
    ).toEqual({ ok: false, field: 'seed' });
  });
});

describe('objective grading', () => {
  const single = {
    position: 1,
    type: 'single' as const,
    points: 2,
    options: [
      { value: 'A', label: 'x' },
      { value: 'B', label: 'y' },
    ],
  };
  const multiple = { ...single, position: 2, type: 'multiple' as const, points: 3 };

  it('never matches an empty or malformed key', () => {
    expect(isUsableKey(single, [])).toBe(false);
    expect(gradeItem(single, [], [])).toMatchObject({ outcome: 'ungradable', earned: 0 });
    expect(gradeItem(single, ['C'], ['C'])).toMatchObject({ outcome: 'ungradable' });
    expect(gradeItem(single, ['A', 'B'], ['A', 'B'])).toMatchObject({ outcome: 'ungradable' });
  });

  it('grades single and all-or-nothing multiple choice', () => {
    expect(gradeItem(single, ['B'], ['B'])).toMatchObject({ outcome: 'correct', earned: 2 });
    expect(gradeItem(single, ['B'], ['A'])).toMatchObject({ outcome: 'incorrect', earned: 0 });
    expect(gradeItem(single, ['B'], undefined)).toMatchObject({ outcome: 'unanswered' });
    expect(gradeItem(multiple, ['A', 'B'], ['B', 'A'])).toMatchObject({ outcome: 'correct' });
    expect(gradeItem(multiple, ['A', 'B'], ['A'])).toMatchObject({ outcome: 'incorrect' });
    expect(gradeItem(multiple, ['A'], ['A', 'A'])).toMatchObject({ outcome: 'incorrect' });
  });

  it('totals only gradable items', () => {
    const grading = gradeAttempt(
      [
        { ...single, key: ['A'] },
        { ...multiple, key: ['A', 'B'] },
        { ...single, position: 3, key: [] },
      ],
      { '1': ['A'], '2': ['A'] },
    );
    expect(grading).toMatchObject({
      version: 'objective-v1',
      earned: 2,
      totalPoints: 5,
      correct: 1,
      unanswered: 0,
      ungradable: 1,
    });
  });

  it('accepts only well-formed answers', () => {
    const items = [single, multiple];
    expect(parseAnswers({ '1': ['B'], '2': ['B', 'A'] }, items)).toEqual({
      '1': ['B'],
      '2': ['A', 'B'],
    });
    expect(parseAnswers({ '1': [] }, items)).toEqual({});
    expect(parseAnswers({ '3': ['A'] }, items)).toBeNull();
    expect(parseAnswers({ '1': ['A', 'B'] }, items)).toBeNull();
    expect(parseAnswers({ '2': ['A', 'A'] }, items)).toBeNull();
    expect(parseAnswers({ '1': ['Z'] }, items)).toBeNull();
    expect(parseAnswers(['A'], items)).toBeNull();
    expect(canonicalAnswers({ '2': ['B', 'A'], '1': ['A'] })).toBe('[["1",["A"]],["2",["A","B"]]]');
  });

  it('builds the pre-submission view from an allowlist', () => {
    const view = toItemView(1, {
      type: 'single',
      stem: 's',
      options: [{ value: 'A', label: 'x', correct: true }],
      points: 1,
      concepts: ['k'],
      answer: ['A'],
      explanation: 'leak',
      source: { origin: 'official', verification: 'official_verified', title: 't', secret: 'x' },
    });
    expect(JSON.stringify(view)).not.toMatch(/leak|correct|secret|answer/);
    expect(view.source).toEqual({
      origin: 'official',
      verification: 'official_verified',
      title: 't',
    });
  });
});
