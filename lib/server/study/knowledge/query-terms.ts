/**
 * Keywords of a question for the PGroonga leg of hybrid retrieval: Chinese
 * word segmentation (ICU, via Intl.Segmenter) without question words and
 * single Han characters, plus Latin/number tokens so formula fragments
 * ("a^x", "1 - cos x", "O(n log n)") still match. Matched with `&@|` (any
 * keyword), ranked by pgroonga_score.
 */
const STOPWORDS = new Set(
  '什么 怎么 怎样 如何 哪些 哪个 哪种 哪天 为什么 是否 多少 可以 能否 之间 关系 以及 的 了 吗 呢 是 有 和 与 在 对 中 时 会 得到 结果 需要 满足 要求 本身 一下 请问 表中 写 内容 结论 几 一个 这个 那个 我们 你们 他们 告诉 解释 说明 介绍 一些 有关 关于 the an of to is are what how why which'.split(
    ' ',
  ),
);
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
export const MAX_QUERY_TERMS = 16;

export function questionTerms(question: string): string[] {
  const terms = new Set<string>();
  for (const part of segmenter.segment(question)) {
    if (!part.isWordLike) continue;
    const word = part.segment.trim().toLowerCase();
    if (!word || STOPWORDS.has(word)) continue;
    if (/^\p{Script=Han}$/u.test(word)) continue;
    terms.add(word);
  }
  for (const token of question.match(/[A-Za-z][A-Za-z0-9_]*|\d+/g) ?? []) {
    const lower = token.toLowerCase();
    if (!STOPWORDS.has(lower)) terms.add(lower);
  }
  return [...terms].slice(0, MAX_QUERY_TERMS);
}
