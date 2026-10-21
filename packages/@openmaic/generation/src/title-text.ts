/**
 * Course and scene titles are shown as plain text (scene list, header,
 * course cards). Models sometimes write formulas in them as LaTeX —
 * `\( (x^3)' \)`, `$\cos x$` — which then shows as source. Titles are
 * turned into readable plain text instead: delimiters dropped, common
 * commands named (cos, sin, ·, ×), simple powers as superscripts (x³).
 * Anything else in the title is left as written.
 */

const SUPERSCRIPTS: Record<string, string> = {
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹',
  '+': '⁺',
  '-': '⁻',
  '(': '⁽',
  ')': '⁾',
  n: 'ⁿ',
  i: 'ⁱ',
};

const SYMBOLS: Record<string, string> = {
  cdot: '·',
  times: '×',
  div: '÷',
  pm: '±',
  le: '≤',
  leq: '≤',
  ge: '≥',
  geq: '≥',
  neq: '≠',
  approx: '≈',
  infty: '∞',
  pi: 'π',
  theta: 'θ',
  alpha: 'α',
  beta: 'β',
  lambda: 'λ',
  Delta: 'Δ',
  to: '→',
  rightarrow: '→',
  int: '∫',
  sum: 'Σ',
  sqrt: '√',
};

function lift(body: string, whole: string): string {
  const chars = Array.from(body.replace(/\s+/gu, ''));
  return chars.length > 0 && chars.every((char) => SUPERSCRIPTS[char])
    ? chars.map((char) => SUPERSCRIPTS[char]).join('')
    : whole;
}

/** One formula as plain text. */
function plainFormula(latex: string): string {
  let text = latex
    .replace(/\\(?:d|t)?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/gu, '$1/$2')
    .replace(/\\left|\\right/gu, '')
    .replace(/\\([A-Za-z]+)/gu, (_whole, name: string) => SYMBOLS[name] ?? name)
    .replace(/\\[,;!: ]/gu, ' ');
  text = text
    .replace(/\^\{([^{}]{1,8})\}/gu, (whole, body: string) => lift(body, whole))
    .replace(/\^([0-9]+|n)(?![A-Za-z0-9{])/gu, (whole, body: string) => lift(body, whole))
    .replace(/[{}]/gu, '');
  return text.replace(/\s+/gu, ' ').trim();
}

/** A title with its LaTeX formulas written as plain text. */
export function plainTitleText(title: string): string {
  if (!/[\\$]/u.test(title)) return title;
  return title
    .replace(/\\\(([\s\S]*?)\\\)/gu, (_whole, body: string) => plainFormula(body))
    .replace(/\\\[([\s\S]*?)\\\]/gu, (_whole, body: string) => plainFormula(body))
    .replace(/\$\$([^$]+)\$\$/gu, (_whole, body: string) => plainFormula(body))
    .replace(/\$([^$\n]+)\$/gu, (_whole, body: string) => plainFormula(body))
    .replace(/\s+/gu, ' ')
    .trim();
}
