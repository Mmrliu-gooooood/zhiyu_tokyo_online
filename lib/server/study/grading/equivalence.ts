/**
 * Program check of a calculation's final answer (learning plan B09), with the
 * Cortex Compute Engine (MIT): `2/4` and `0.5`, `x^2-1` and `(x-1)(x+1)`,
 * `2\sqrt3` and `\sqrt{12}` are the same answer.
 *
 * The verdict is deliberately cautious. `equal` and `not_equal` are only
 * given for plain numbers and for expressions in the same variables, checked
 * symbolically and by evaluating both at fixed sample points; tuples, sets,
 * intervals, equations with different sides, units or anything the parser
 * does not understand are `unknown` and left to the model. Input is limited
 * to a whitelist of elementary notation first, so nothing expensive (huge
 * factorials, sums, integrals) ever reaches the engine on the request thread.
 */
import type { Expression } from '@cortex-js/compute-engine';

import { createLogger } from '@/lib/logger';

const log = createLogger('StudyGradingEquivalence');

export type FinalVerdict = 'equal' | 'not_equal' | 'unknown';

/** Recorded with a grading that used the program check. */
export const EQUIVALENCE_PROGRAM = 'compute-engine@0.128.13';

const MAX_CHARS = 200;
const SAMPLE_POINTS = [0.37, 1.13, 2.71, -0.83, 3.3, -1.7, 0.61];
const MIN_SAMPLES = 3;

/** LaTeX commands an elementary final answer may use. */
const COMMANDS = new Set([
  'frac',
  'dfrac',
  'tfrac',
  'sqrt',
  'pi',
  'infty',
  'times',
  'cdot',
  'div',
  'left',
  'right',
  'sin',
  'cos',
  'tan',
  'cot',
  'sec',
  'csc',
  'arcsin',
  'arccos',
  'arctan',
  'ln',
  'log',
  'exp',
  'mathrm',
  'pm',
  ',',
  ' ',
  ';',
]);

const SUPERSCRIPTS: Record<string, string> = {
  '⁰': '0',
  '¹': '1',
  '²': '2',
  '³': '3',
  '⁴': '4',
  '⁵': '5',
  '⁶': '6',
  '⁷': '7',
  '⁸': '8',
  '⁹': '9',
  '⁻': '-',
};

/**
 * Plain-text habits to LaTeX: `x²`, `√3`, `sqrt(2)`, `π`, `×`, full-width
 * characters, a leading `答：`, `$…$`, a trailing full stop. Null when the
 * text uses anything outside the whitelist.
 */
export function normalizeFinalAnswer(raw: string): string | null {
  let text = raw.trim();
  if (!text || text.length > MAX_CHARS) return null;
  text = text.replace(
    /[⁰¹²³⁴⁵⁶⁷⁸⁹⁻]+/g,
    (run) => `^{${[...run].map((c) => SUPERSCRIPTS[c]).join('')}}`,
  );
  text = text.normalize('NFKC');
  text = text
    .replace(/^(?:最终答案|答案|答|结果|解)\s*[:：]\s*/u, '')
    .replace(/^\$+|\$+$/g, '')
    .replace(/^\\\(|\\\)$/g, '')
    .replace(/^\\\[|\\\]$/g, '')
    .replace(/[。.]$/u, '')
    .trim();
  text = text
    .replace(/×/g, '\\times ')
    .replace(/[·⋅]/g, '\\cdot ')
    .replace(/÷/g, '\\div ')
    .replace(/[−–]/g, '-')
    .replace(/π/g, '\\pi ')
    .replace(/∞/g, '\\infty ')
    .replace(/±/g, '\\pm ')
    .replace(/(?<!\\)\bpi\b/g, '\\pi ')
    .replace(/\bsqrt\s*\(([^()]*)\)/g, '\\sqrt{$1}')
    .replace(/√\s*\(([^()]*)\)/g, '\\sqrt{$1}')
    .replace(/√\s*([0-9.]+|[A-Za-z])/g, '\\sqrt{$1}');
  if (!text || text.includes('√')) return null;
  // Whitelist: commands from COMMANDS, ASCII letters/digits and elementary symbols.
  for (const match of text.matchAll(/\\([A-Za-z]+|.)/g)) {
    if (!COMMANDS.has(match[1]!)) return null;
  }
  if (/[^A-Za-z0-9\\{}()[\]^_+\-*/=.,;:!|<> ]/.test(text)) return null;
  // Factorials only of small literal numbers (a big one would block the thread).
  for (const match of text.matchAll(/(\S?)!/g)) {
    const before = text.slice(0, match.index! + match[1]!.length);
    const number = /(\d+)$/.exec(before);
    if (!number || Number(number[1]) > 20) return null;
  }
  return text;
}

type Module = typeof import('@cortex-js/compute-engine');
type Engine = InstanceType<Module['ComputeEngine']>;
type Expr = Expression;

let modulePromise: Promise<{ ce: Engine; lib: Module }> | null = null;

/** Loaded on first use (the engine is large and only grading needs it). */
function engine(): Promise<{ ce: Engine; lib: Module }> {
  modulePromise ??= import('@cortex-js/compute-engine').then((lib) => ({
    ce: new lib.ComputeEngine(),
    lib,
  }));
  return modulePromise;
}

function realValue(expr: Expr): number | null {
  const value = expr.N();
  const re = value.re;
  const im = value.im;
  if (typeof re !== 'number' || !Number.isFinite(re)) return null;
  if (typeof im === 'number' && Number.isFinite(im) && Math.abs(im) > 1e-12) return null;
  if (typeof im === 'number' && Number.isNaN(im)) return null;
  return re;
}

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/** `x = 2` against `2`: compare the right-hand side when one side is a plain assignment. */
function sides(lib: Module, expr: Expr): { variable: string | null; value: Expr } {
  if (lib.isFunction(expr, 'Equal') && expr.ops.length === 2) {
    const [left, right] = expr.ops;
    if (lib.isSymbol(left)) return { variable: left.symbol, value: right! };
  }
  return { variable: null, value: expr };
}

function compare(ce: Engine, a: Expr, b: Expr): FinalVerdict {
  try {
    if (a.isEqual(b) === true) return 'equal';
  } catch {
    // fall through to numeric checks
  }
  const varsA = [...a.freeVariables].sort();
  const varsB = [...b.freeVariables].sort();
  if (varsA.join() !== varsB.join()) return 'unknown';
  if (varsA.length === 0) {
    const x = realValue(a);
    const y = realValue(b);
    if (x === null || y === null) return 'unknown';
    return close(x, y) ? 'equal' : 'not_equal';
  }
  if (varsA.length > 3) return 'unknown';
  let agreed = 0;
  for (const [index, point] of SAMPLE_POINTS.entries()) {
    const values = Object.fromEntries(
      varsA.map((name, offset) => [name, ce.number(point + offset * 0.29 + index * 0.01)]),
    );
    const x = realValue(a.subs(values));
    const y = realValue(b.subs(values));
    if (x === null || y === null) continue;
    if (!close(x, y)) return 'not_equal';
    agreed += 1;
  }
  return agreed >= MIN_SAMPLES ? 'equal' : 'unknown';
}

/** Whether the student's final answer is the reference's. Never throws. */
export async function compareFinalAnswers(
  student: string,
  reference: string,
): Promise<FinalVerdict> {
  const left = normalizeFinalAnswer(student);
  const right = normalizeFinalAnswer(reference);
  if (!left || !right) return 'unknown';
  try {
    const { ce, lib } = await engine();
    const a = ce.parse(left);
    const b = ce.parse(right);
    if (!a.isValid || !b.isValid) return 'unknown';
    const sa = sides(lib, a);
    const sb = sides(lib, b);
    if (sa.variable && sb.variable && sa.variable !== sb.variable) return 'unknown';
    const x = sa.value;
    const y = sb.value;
    // Structures (tuples, sets, intervals, remaining equations) are only ever "equal" here.
    const plain = (expr: Expr) =>
      ![
        'Tuple',
        'Set',
        'List',
        'Interval',
        'Equal',
        'Less',
        'Greater',
        'LessEqual',
        'GreaterEqual',
        'Sequence',
        'PlusMinus',
      ].includes(String(expr.operator));
    if (!plain(x) || !plain(y)) {
      try {
        return x.isEqual(y) === true ? 'equal' : 'unknown';
      } catch {
        return 'unknown';
      }
    }
    return compare(ce, x, y);
  } catch (error) {
    log.warn('final answer comparison failed', { error: (error as Error).message });
    return 'unknown';
  }
}
