import { describe, expect, it } from 'vitest';

import {
  answerLetters,
  extractQuestions,
  joinLines,
  parseBlock,
  splitOptions,
} from '@/lib/study/extraction/rules';
import {
  candidateIssues,
  isCommittable,
  parseCandidateContent,
} from '@/lib/study/extraction/candidate';
import { parseAssistOutput } from '@/lib/server/study/extraction/assist';

const page = (number: number, ...lines: string[]) => ({ page: number, text: lines.join('\n') });

describe('splitOptions', () => {
  it('splits options on one line and one per line', () => {
    expect(splitOptions('导数是（ ）\nA. 1 B. 2 C. 3 D. 4')).toEqual({
      stem: '导数是（ ）',
      options: [
        { value: 'A', label: '1' },
        { value: 'B', label: '2' },
        { value: 'C', label: '3' },
        { value: 'D', label: '4' },
      ],
    });
    expect(
      splitOptions('下列说法正确的是\n(A) 甲\n(B) 乙\n（C）丙')?.options.map((o) => o.label),
    ).toEqual(['甲', '乙', '丙']);
  });

  it('ignores letters inside the stem that are not an A, B, … sequence', () => {
    expect(splitOptions('设 A、B 两点间的距离为 d，则\nA．d>0 B．d<0')?.stem).toBe(
      '设 A、B 两点间的距离为 d，则',
    );
    expect(splitOptions('设矩阵 A 可逆，求 A 的逆')).toBeNull();
  });
});

describe('parseBlock', () => {
  it('reads inline answers and explanations', () => {
    const block = parseBlock([
      { page: 1, text: '3．函数 y=x² 的导数为（ ）' },
      { page: 1, text: 'A．x B．2x C．x² D．2' },
      { page: 1, text: '【答案】B' },
      { page: 1, text: '【解析】由幂函数求导公式得 2x。' },
    ]);
    expect(block.label).toBe('3');
    expect(block.content).toMatchObject({
      type: 'single',
      stem: '函数 y=x² 的导数为（ ）',
      answer: ['B'],
      explanation: '由幂函数求导公式得 2x。',
    });
    expect(block.answerRef).toMatchObject({ kind: 'inline', page: 1 });
  });

  it('takes "故选" from a solution and marks several letters as multiple choice', () => {
    const block = parseBlock([
      { page: 2, text: '4. 下列函数中是奇函数的是' },
      { page: 2, text: 'A. sin x B. x³ C. cos x D. x²' },
      { page: 2, text: '解：sin x 与 x³ 都满足 f(-x)=-f(x)，故选 AB。' },
    ]);
    expect(block.content.type).toBe('multiple');
    expect(block.content.answer).toEqual(['A', 'B']);
  });

  it('keeps questions without options as open candidates with their printed answer', () => {
    const block = parseBlock([
      { page: 1, text: '5. 求极限 lim(x→0) sin x / x。' },
      { page: 1, text: '答案：1' },
    ]);
    expect(block.content.type).toBe('open');
    expect(block.content.answer).toEqual([]);
    expect(block.content.referenceAnswer).toBe('1');
  });

  it('does not accept an answer letter that is not an option', () => {
    const block = parseBlock([
      { page: 1, text: '1. 选择 A. 甲 B. 乙' },
      { page: 1, text: '【答案】D' },
    ]);
    expect(block.content.answer).toEqual([]);
    expect(block.answerRef).toBeNull();
  });
});

describe('extractQuestions', () => {
  it('extracts numbered questions, follows page breaks and skips scanned pages', () => {
    const result = extractQuestions([
      page(
        1,
        '高等数学习题册',
        '习题 1.1',
        '1. 函数 f(x)=x² 在 x=1 处的导数是（ ）',
        'A. 1 B. 2 C. 3 D. 4',
        '2．下列函数在 x=0 处连续的是',
        '— 1 —',
      ),
      page(
        2,
        '高等数学习题册',
        'A. 1/x B. |x|',
        'C. ln x D. tan(1/x)',
        '3. 求 2 的平方根。',
        '— 2 —',
      ),
      { page: 3, text: null },
      page(4, '高等数学习题册', '参考答案', '1. B 2. B', '3. ±√2', '— 4 —'),
    ]);
    expect(result.stats.skippedPages).toEqual([3]);
    expect(result.candidates.map((c) => c.label)).toEqual(['1', '2', '3']);
    const [first, second, third] = result.candidates;
    expect(first).toMatchObject({ section: '习题 1.1', answerBasis: 'source', pages: [1] });
    expect(first!.content.answer).toEqual(['B']);
    // Question 2 continues on page 2 (running head and page numbers dropped).
    expect(second!.pages).toEqual([1, 2]);
    expect(second!.content.options.map((o) => o.label)).toEqual(['1/x', '|x|', 'ln x', 'tan(1/x)']);
    expect(second!.content.answer).toEqual(['B']);
    expect(second!.answerRef).toMatchObject({ kind: 'answer_key', page: 4 });
    expect(third!.content).toMatchObject({ type: 'open', referenceAnswer: '±√2' });
    expect(result.stats).toMatchObject({ candidates: 3, choice: 2, open: 1, answersFromSource: 3 });
    expect(result.stats.unmatchedAnswers).toEqual([]);
  });

  it('pairs answer keys with their exercise sets by section number', () => {
    const result = extractQuestions([
      page(
        1,
        '习题 1.1',
        '1. 甲题 A. 1 B. 2',
        '2. 乙题 A. 1 B. 2',
        '习题 1.2',
        '1. 丙题 A. 1 B. 2',
      ),
      page(2, '习题答案', '习题 1.2', '1. A', '习题 1.1', '1. B 2. A'),
    ]);
    expect(result.candidates.map((c) => [c.content.stem, c.content.answer.join('')])).toEqual([
      ['甲题', 'B'],
      ['乙题', 'A'],
      ['丙题', 'A'],
    ]);
  });

  it('reads compact answer ranges and leaves unmatched keys reported', () => {
    const result = extractQuestions([
      page(1, '一、选择题', '1. 甲 A. 1 B. 2', '2. 乙 A. 1 B. 2', '3. 丙 A. 1 B. 2'),
      page(2, '参考答案', '1~3 BAB', '9. C'),
    ]);
    expect(result.candidates.map((c) => c.content.answer.join(''))).toEqual(['B', 'A', 'B']);
    expect(result.stats.unmatchedAnswers).toEqual([{ label: '9', page: 2, text: 'C' }]);
  });

  it('does not start a question on a number that jumps backwards or far ahead', () => {
    const result = extractQuestions([
      page(1, '1. 已知数列满足', '2023. 年份不是题号', '2. 第二题 A. 甲 B. 乙'),
    ]);
    expect(result.candidates.map((c) => c.label)).toEqual(['1', '2']);
    expect(result.candidates[0]!.content.stem).toContain('2023. 年份不是题号');
  });

  it('gives a page figure to the question that mentions it', () => {
    const result = extractQuestions(
      [page(1, '1. 如图所示，三角形 ABC 中 AB=AC，则', 'A. ∠B=∠C B. ∠A=∠B', '2. 计算 1+1。')],
      [
        { id: 'img_1', page: 1 },
        { id: 'img_2', page: 9 },
      ],
    );
    expect(result.candidates[0]!.content.figures).toEqual(['img_1']);
    expect(result.candidates[1]!.content.figures).toEqual([]);
    expect(result.stats.unassignedFigures).toEqual([]);
  });

  it('reports page figures no question claims', () => {
    const result = extractQuestions([page(1, '1. 计算 1+1。')], [{ id: 'img_1', page: 1 }]);
    expect(result.stats.unassignedFigures).toEqual([{ imageId: 'img_1', page: 1 }]);
  });

  it('treats fill-in and proof sections as open questions', () => {
    const result = extractQuestions([
      page(
        1,
        '二、填空题',
        '1. 函数 y=x² 的导数是 ____。',
        '三、解答题',
        '1. 证明 A. 一定成立 B. 不成立',
      ),
    ]);
    expect(result.candidates.map((c) => c.content.type)).toEqual(['open', 'open']);
  });

  it('reads a book with only scanned pages as empty', () => {
    const result = extractQuestions([
      { page: 1, text: null },
      { page: 2, text: '  ' },
    ]);
    expect(result.candidates).toEqual([]);
    expect(result.stats.skippedPages).toEqual([1, 2]);
  });
});

describe('helpers', () => {
  it('joins wrapped lines without spaces between Chinese text', () => {
    expect(joinLines(['设函数', 'f(x) 在', 'x=0 处可导'])).toBe('设函数f(x) 在x=0 处可导');
    expect(joinLines(['Let f be', 'continuous'])).toBe('Let f be continuous');
  });

  it('reads answer letters in their common spellings', () => {
    expect(answerLetters('Ａ，Ｃ')).toEqual(['A', 'C']);
    expect(answerLetters('CA')).toEqual(['A', 'C']);
    expect(answerLetters('x=1')).toBeNull();
  });
});

describe('candidate editing rules', () => {
  const base = {
    type: 'single',
    stem: '1+1=?',
    options: [
      { value: 'A', label: '1' },
      { value: 'B', label: '2' },
    ],
    answer: ['B'],
    explanation: null,
    concepts: ['加法'],
    difficulty: null,
    points: 1,
    figures: ['img_1'],
    referenceAnswer: null,
  };

  it('validates choice candidates like bank questions and keeps figures of this parse only', () => {
    const parsed = parseCandidateContent(base, new Set(['img_1']));
    expect(parsed.content).toMatchObject({ type: 'single', answer: ['B'], figures: ['img_1'] });
    expect(isCommittable(parsed.content!)).toBe(true);
    expect(
      parseCandidateContent({ ...base, figures: ['img_2'] }, new Set(['img_1'])).content,
    ).toBeNull();
    expect(
      parseCandidateContent({ ...base, figures: ['img_1', 'img_1'] }, new Set(['img_1'])).content,
    ).toBeNull();
    // A missing answer is a draft, still committable; a wrong key is not.
    const draft = parseCandidateContent({ ...base, answer: [] }, new Set(['img_1'])).content!;
    expect(isCommittable(draft)).toBe(true);
    expect(isCommittable({ ...draft, answer: ['C'] })).toBe(false);
  });

  it('keeps open candidates editable but never committable', () => {
    const parsed = parseCandidateContent(
      { ...base, type: 'open', options: [], answer: [], referenceAnswer: ' 2 ' },
      new Set(['img_1']),
    );
    expect(parsed.content).toMatchObject({ type: 'open', options: [], referenceAnswer: '2' });
    expect(isCommittable(parsed.content!)).toBe(false);
    expect(candidateIssues({ ...parsed.content!, stem: '' })).toEqual([
      { path: 'stem', code: 'stem_missing' },
    ]);
  });
});

describe('model help output', () => {
  const ids = new Set(['qc-aaaaaaaaaaaa', 'qc-bbbbbbbbbbbb']);

  it('keeps well-formed suggestions and drops everything else', () => {
    const parsed = parseAssistOutput(
      '```json\n' +
        JSON.stringify({
          items: [
            {
              id: 'qc-aaaaaaaaaaaa',
              type: 'single',
              stem: '$x^2$ 的导数',
              options: [{ label: '$2x$' }, { label: '$x$' }],
              answer: ['a'],
              reason: '幂函数求导',
            },
            // An answer that is not an option is dropped, the rest kept.
            {
              id: 'qc-bbbbbbbbbbbb',
              type: 'multiple',
              stem: '哪些',
              options: [{ label: '甲' }, { label: '乙' }],
              answer: ['C'],
              reason: 'x',
            },
            { id: 'qc-unknown0000', type: 'single', stem: 's', options: [], answer: [] },
          ],
        }) +
        '\n```',
      ids,
    );
    expect(parsed?.get('qc-aaaaaaaaaaaa')).toEqual({
      type: 'single',
      stem: '$x^2$ 的导数',
      options: [
        { value: 'A', label: '$2x$' },
        { value: 'B', label: '$x$' },
      ],
      answer: ['A'],
      explanation: '幂函数求导',
    });
    expect(parsed?.get('qc-bbbbbbbbbbbb')).toMatchObject({ answer: [], explanation: null });
    expect(parsed?.has('qc-unknown0000')).toBe(false);
    expect(parseAssistOutput('not json', ids)).toBeNull();
  });

  it('refuses two answers for a single-choice question and options it cannot read', () => {
    const parsed = parseAssistOutput(
      JSON.stringify({
        items: [
          {
            id: 'qc-aaaaaaaaaaaa',
            type: 'single',
            stem: 's',
            options: [{ label: '甲' }, { label: '乙' }],
            answer: ['A', 'B'],
          },
          { id: 'qc-bbbbbbbbbbbb', type: 'single', stem: 's', options: [{ label: '' }, {}] },
        ],
      }),
      ids,
    );
    expect(parsed?.get('qc-aaaaaaaaaaaa')?.answer).toEqual([]);
    expect(parsed?.has('qc-bbbbbbbbbbbb')).toBe(false);
  });
});
