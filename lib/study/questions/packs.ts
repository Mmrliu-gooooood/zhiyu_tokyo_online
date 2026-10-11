/**
 * Official question packs (learning plan B07): a small, read-only public
 * catalogue shipped with the app. Each pack has a version, attribution and
 * licence; its questions keep a stable id within that version, so a paper
 * that froze one can still name where it came from. Students never edit a
 * pack — copying a question into their own bank makes a private copy.
 *
 * Only packs whose content we wrote or are licensed to ship belong here (the
 * public datasets in the plan's reference list are not, until their licence
 * is confirmed). Packs are code, not rows: no account owns them, nothing
 * writes them, and a new version is a new entry.
 */
import type { QuestionContent } from '@/lib/study/questions/contracts';

export interface QuestionPack {
  id: string;
  version: number;
  title: string;
  subject: string;
  language: string;
  attribution: string;
  license: string;
  sourceUrl: string | null;
  publishedAt: string;
  questions: Array<Omit<QuestionContent, 'source'> & { id: string }>;
}

export interface QuestionPackSummary {
  id: string;
  version: number;
  title: string;
  subject: string;
  attribution: string;
  license: string;
  sourceUrl: string | null;
  questionCount: number;
}

const CALCULUS_BASICS_V1: QuestionPack = {
  id: 'zhiyu-calculus-basics',
  version: 1,
  title: '高等数学基础：极限、导数与积分',
  subject: '高等数学',
  language: 'zh-CN',
  attribution: '智域团队编写（原创题目）',
  license: 'CC BY 4.0',
  sourceUrl: null,
  publishedAt: '2026-10-11',
  questions: [
    {
      id: 'lim-01',
      type: 'single',
      stem: '$\\lim_{x \\to 0} \\dfrac{\\sin x}{x}$ 等于',
      options: [
        { value: 'A', label: '$0$' },
        { value: 'B', label: '$1$' },
        { value: 'C', label: '$\\infty$' },
        { value: 'D', label: '不存在' },
      ],
      answer: ['B'],
      explanation: '第一个重要极限：$\\lim_{x \\to 0} \\dfrac{\\sin x}{x} = 1$。',
      concepts: ['极限'],
      difficulty: 1,
      points: 1,
    },
    {
      id: 'lim-02',
      type: 'single',
      stem: '$\\lim_{x \\to \\infty} \\left(1 + \\dfrac{1}{x}\\right)^{x}$ 等于',
      options: [
        { value: 'A', label: '$1$' },
        { value: 'B', label: '$e$' },
        { value: 'C', label: '$0$' },
        { value: 'D', label: '$\\infty$' },
      ],
      answer: ['B'],
      explanation: '第二个重要极限，结果为 $e$；不能按“$1^{\\infty} = 1$”计算。',
      concepts: ['极限'],
      difficulty: 2,
      points: 1,
    },
    {
      id: 'lim-03',
      type: 'single',
      stem: '$\\lim_{x \\to 0} \\dfrac{1 - \\cos x}{x^{2}}$ 等于',
      options: [
        { value: 'A', label: '$0$' },
        { value: 'B', label: '$\\dfrac{1}{2}$' },
        { value: 'C', label: '$1$' },
        { value: 'D', label: '$2$' },
      ],
      answer: ['B'],
      explanation:
        '当 $x \\to 0$ 时 $1 - \\cos x \\sim \\dfrac{x^{2}}{2}$，所以极限为 $\\dfrac{1}{2}$。',
      concepts: ['极限', '等价无穷小'],
      difficulty: 2,
      points: 1,
    },
    {
      id: 'lim-04',
      type: 'multiple',
      stem: '当 $x \\to 0$ 时，下列哪些是与 $x$ 等价的无穷小？',
      options: [
        { value: 'A', label: '$\\sin x$' },
        { value: 'B', label: '$\\tan x$' },
        { value: 'C', label: '$\\ln(1 + x)$' },
        { value: 'D', label: '$1 - \\cos x$' },
      ],
      answer: ['A', 'B', 'C'],
      explanation:
        '$\\sin x$、$\\tan x$、$\\ln(1+x)$ 都与 $x$ 等价；$1 - \\cos x \\sim \\dfrac{x^{2}}{2}$，是比 $x$ 高阶的无穷小。',
      concepts: ['等价无穷小'],
      difficulty: 3,
      points: 2,
    },
    {
      id: 'cont-01',
      type: 'single',
      stem: '函数 $f(x) = |x|$ 在 $x = 0$ 处',
      options: [
        { value: 'A', label: '连续且可导' },
        { value: 'B', label: '连续但不可导' },
        { value: 'C', label: '不连续但可导' },
        { value: 'D', label: '既不连续也不可导' },
      ],
      answer: ['B'],
      explanation: '左右极限都为 $0$，所以连续；左导数为 $-1$、右导数为 $1$，不相等，所以不可导。',
      concepts: ['连续性', '导数'],
      difficulty: 2,
      points: 1,
    },
    {
      id: 'cont-02',
      type: 'multiple',
      stem: '下列函数中，在 $x = 0$ 处连续的有',
      options: [
        { value: 'A', label: '$f(x) = x^{2}$' },
        { value: 'B', label: '$f(x) = \\dfrac{\\sin x}{x}\\ (x \\ne 0)$，$f(0) = 1$' },
        { value: 'C', label: '$f(x) = \\dfrac{1}{x}\\ (x \\ne 0)$，$f(0) = 0$' },
        { value: 'D', label: '$f(x) = |x|$' },
      ],
      answer: ['A', 'B', 'D'],
      explanation: 'C 在 $x \\to 0$ 时极限不存在，所以不连续；其余三个的极限都等于函数值。',
      concepts: ['连续性'],
      difficulty: 2,
      points: 2,
    },
    {
      id: 'der-01',
      type: 'single',
      stem: "$(x^{3})'$ 等于",
      options: [
        { value: 'A', label: '$x^{2}$' },
        { value: 'B', label: '$3x^{2}$' },
        { value: 'C', label: '$3x$' },
        { value: 'D', label: '$\\dfrac{x^{3}}{3}$' },
      ],
      answer: ['B'],
      explanation: "幂函数求导：$(x^{n})' = n x^{n-1}$。",
      concepts: ['导数'],
      difficulty: 1,
      points: 1,
    },
    {
      id: 'der-02',
      type: 'single',
      stem: "$(e^{2x})'$ 等于",
      options: [
        { value: 'A', label: '$e^{2x}$' },
        { value: 'B', label: '$2e^{2x}$' },
        { value: 'C', label: '$2x e^{2x-1}$' },
        { value: 'D', label: '$\\dfrac{e^{2x}}{2}$' },
      ],
      answer: ['B'],
      explanation: '复合函数求导：外层 $e^{u}$ 的导数是 $e^{u}$，再乘内层 $2x$ 的导数 $2$。',
      concepts: ['导数'],
      difficulty: 1,
      points: 1,
    },
    {
      id: 'der-03',
      type: 'single',
      stem: "当 $x > 0$ 时，$(\\ln x)'$ 等于",
      options: [
        { value: 'A', label: '$\\dfrac{1}{x}$' },
        { value: 'B', label: '$\\ln x$' },
        { value: 'C', label: '$x$' },
        { value: 'D', label: '$e^{x}$' },
      ],
      answer: ['A'],
      explanation: "基本求导公式：$(\\ln x)' = \\dfrac{1}{x}$。",
      concepts: ['导数'],
      difficulty: 1,
      points: 1,
    },
    {
      id: 'der-04',
      type: 'single',
      stem: "$(\\sin x \\cos x)'$ 等于",
      options: [
        { value: 'A', label: '$\\cos 2x$' },
        { value: 'B', label: '$-\\sin 2x$' },
        { value: 'C', label: '$\\cos^{2} x$' },
        { value: 'D', label: '$\\sin 2x$' },
      ],
      answer: ['A'],
      explanation:
        '$\\sin x \\cos x = \\dfrac{1}{2}\\sin 2x$，求导得 $\\cos 2x$；也可用乘积法则得 $\\cos^{2} x - \\sin^{2} x = \\cos 2x$。',
      concepts: ['导数'],
      difficulty: 2,
      points: 1,
    },
    {
      id: 'der-05',
      type: 'single',
      stem: '曲线 $y = x^{2}$ 在点 $(1, 1)$ 处的切线方程是',
      options: [
        { value: 'A', label: '$y = 2x - 1$' },
        { value: 'B', label: '$y = 2x + 1$' },
        { value: 'C', label: '$y = x$' },
        { value: 'D', label: '$y = 2x$' },
      ],
      answer: ['A'],
      explanation: "斜率 $y'(1) = 2$，切线 $y - 1 = 2(x - 1)$，即 $y = 2x - 1$。",
      concepts: ['导数'],
      difficulty: 2,
      points: 1,
    },
    {
      id: 'app-01',
      type: 'multiple',
      stem: '函数 $f(x) = x^{3} - 3x$ 的极值点有',
      options: [
        { value: 'A', label: '$x = -1$' },
        { value: 'B', label: '$x = 0$' },
        { value: 'C', label: '$x = 1$' },
        { value: 'D', label: '$x = 3$' },
      ],
      answer: ['A', 'C'],
      explanation:
        "$f'(x) = 3x^{2} - 3 = 0$ 得 $x = \\pm 1$；$f''(x) = 6x$ 在这两点不为零，所以 $x = -1$ 是极大值点，$x = 1$ 是极小值点。",
      concepts: ['导数应用'],
      difficulty: 3,
      points: 2,
    },
    {
      id: 'app-02',
      type: 'single',
      stem: "若 $f'(x_{0}) = 0$，则 $x_{0}$",
      options: [
        { value: 'A', label: '一定是极值点' },
        { value: 'B', label: '一定不是极值点' },
        { value: 'C', label: '可能是极值点，也可能不是' },
        { value: 'D', label: '一定是拐点' },
      ],
      answer: ['C'],
      explanation:
        '驻点不一定是极值点：$x^{2}$ 在 $0$ 处取极小值，而 $x^{3}$ 在 $0$ 处导数为零却不是极值点。',
      concepts: ['导数应用'],
      difficulty: 2,
      points: 1,
    },
    {
      id: 'int-01',
      type: 'single',
      stem: '$\\int_{0}^{1} x \\, dx$ 等于',
      options: [
        { value: 'A', label: '$1$' },
        { value: 'B', label: '$\\dfrac{1}{2}$' },
        { value: 'C', label: '$2$' },
        { value: 'D', label: '$0$' },
      ],
      answer: ['B'],
      explanation:
        '$\\int_{0}^{1} x \\, dx = \\left.\\dfrac{x^{2}}{2}\\right|_{0}^{1} = \\dfrac{1}{2}$。',
      concepts: ['积分'],
      difficulty: 1,
      points: 1,
    },
    {
      id: 'int-02',
      type: 'single',
      stem: '$\\int \\cos x \\, dx$ 等于',
      options: [
        { value: 'A', label: '$\\sin x + C$' },
        { value: 'B', label: '$-\\sin x + C$' },
        { value: 'C', label: '$\\cos x + C$' },
        { value: 'D', label: '$-\\cos x + C$' },
      ],
      answer: ['A'],
      explanation: "因为 $(\\sin x)' = \\cos x$。",
      concepts: ['积分'],
      difficulty: 1,
      points: 1,
    },
  ],
};

export const OFFICIAL_PACKS: readonly QuestionPack[] = [CALCULUS_BASICS_V1];

export function findPack(id: string): QuestionPack | null {
  return OFFICIAL_PACKS.find((pack) => pack.id === id) ?? null;
}

export function packSummary(pack: QuestionPack): QuestionPackSummary {
  return {
    id: pack.id,
    version: pack.version,
    title: pack.title,
    subject: pack.subject,
    attribution: pack.attribution,
    license: pack.license,
    sourceUrl: pack.sourceUrl,
    questionCount: pack.questions.length,
  };
}

/** A pack question as bank content: its source names the pack, version and licence. */
export function packQuestionContent(
  pack: QuestionPack,
  question: QuestionPack['questions'][number],
): QuestionContent {
  const { id, ...content } = question;
  return {
    ...content,
    source: {
      title: pack.title,
      license: pack.license,
      attribution: pack.attribution,
      ...(pack.sourceUrl ? { url: pack.sourceUrl } : {}),
      pack: { id: pack.id, version: pack.version, questionId: id },
    },
  };
}
