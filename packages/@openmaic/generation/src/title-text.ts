/**
 * Course and scene titles are shown as plain text (scene list, header,
 * course cards). Models sometimes write formulas in them as LaTeX —
 * `\( (x^3)' \)`, `$\cos x$` — which then shows as source. Titles are
 * turned into readable plain text instead: delimiters dropped, common
 * commands named (cos, sin, ·, ×), simple powers as superscripts (x³),
 * other powers and groups kept in parentheses (e^(2x), √(x+1), (a+b)/2).
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
};

/** Commands that take braced arguments; written out after the symbols. */
const STRUCTURAL = new Set(['frac', 'dfrac', 'tfrac', 'sqrt']);

/** Superscript characters for `body`, or null when one of them has none. */
function lift(body: string): string | null {
  const chars = Array.from(body.replace(/\s+/gu, ''));
  return chars.length > 0 && chars.every((char) => SUPERSCRIPTS[char])
    ? chars.map((char) => SUPERSCRIPTS[char]).join('')
    : null;
}

/**
 * A braced group once its braces are gone: in parentheses when longer than
 * one character, so `e^{2x}` reads e^(2x), not e^2x (e² times x).
 */
function group(body: string): string {
  const text = body.trim();
  return Array.from(text).length > 1 ? `(${text})` : text;
}

/** A fraction part, in parentheses when it is a sum or difference: (a+b)/2. */
function fractionPart(body: string): string {
  const text = body.trim();
  return /[+\-−±\s]/u.test(text) ? `(${text})` : text;
}

/** One formula as plain text. */
function plainFormula(latex: string): string {
  let text = latex
    .replace(/\\(?:left|right)(?![A-Za-z])/gu, '')
    .replace(/\\([A-Za-z]+)/gu, (whole, name: string) =>
      STRUCTURAL.has(name) ? whole : (SYMBOLS[name] ?? name),
    )
    .replace(
      /\\(?:d|t)?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/gu,
      (_whole, top: string, bottom: string) => `${fractionPart(top)}/${fractionPart(bottom)}`,
    )
    .replace(/\\sqrt\s*\{([^{}]*)\}/gu, (_whole, body: string) => `√${group(body)}`)
    .replace(/\\sqrt/gu, '√')
    .replace(/\\(?:d|t)?frac/gu, '')
    .replace(/\\[,;!: ]/gu, ' ');
  text = text
    .replace(/\^\{([^{}]{1,8})\}/gu, (_whole, body: string) => lift(body) ?? `^${group(body)}`)
    .replace(/\^([0-9]+|n)(?![A-Za-z0-9{])/gu, (whole, body: string) => lift(body) ?? whole)
    .replace(/_\{([^{}]{1,8})\}/gu, (_whole, body: string) => `_${group(body)}`)
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
