/**
 * Final-answer check of calculations (learning plan B09): equivalent forms
 * are `equal`, different numbers `not_equal`, and anything uncertain (other
 * variables, structures, notation outside the whitelist) `unknown`, which
 * leaves the point to the model.
 */
import { describe, expect, it } from 'vitest';

import { compareFinalAnswers, normalizeFinalAnswer } from '@/lib/server/study/grading/equivalence';

describe('final answer normalization', () => {
  it('turns plain-text habits into LaTeX and rejects anything outside the whitelist', () => {
    expect(normalizeFinalAnswer('答：x²-1。')).toBe('x^{2}-1');
    expect(normalizeFinalAnswer('$\\frac{1}{2}$')).toBe('\\frac{1}{2}');
    expect(normalizeFinalAnswer('2√3')).toBe('2\\sqrt{3}');
    expect(normalizeFinalAnswer('sqrt(2)/2')).toBe('\\sqrt{2}/2');
    expect(normalizeFinalAnswer('π/2')).toBe('\\pi /2');
    expect(normalizeFinalAnswer('１／２')).toBe('1/2');
    expect(normalizeFinalAnswer('\\int_0^1 x dx')).toBeNull();
    expect(normalizeFinalAnswer('\\sum_{n=1}^{100} n')).toBeNull();
    expect(normalizeFinalAnswer('100000!')).toBeNull();
    expect(normalizeFinalAnswer('5!')).toBe('5!');
    expect(normalizeFinalAnswer('x=1 或 x=2')).toBeNull();
    expect(normalizeFinalAnswer('x'.repeat(201))).toBeNull();
    expect(normalizeFinalAnswer('   ')).toBeNull();
  });
});

describe('final answer comparison', () => {
  it.each([
    ['0.5', '\\frac{2}{4}'],
    ['(x-1)(x+1)', 'x^2-1'],
    ['2\\sqrt{3}', '\\sqrt{12}'],
    ['\\frac{\\sqrt3}{2}', '\\sin(\\pi/3)'],
    ['x=2', '2'],
    ['2(x+1)', '2x+2'],
    ['1/2', '0.5'],
    ['x²-1', 'x^2-1'],
    ['(1,2)', '(1,2)'],
    ['5!', '120'],
  ])('%s equals %s', async (student, reference) => {
    expect(await compareFinalAnswers(student, reference)).toBe('equal');
  });

  it.each([
    ['0.333', '1/3'],
    ['3x^3', '3x^2'],
    ['\\sqrt{x^2}', 'x'],
    ['2', '3'],
  ])('%s does not equal %s', async (student, reference) => {
    expect(await compareFinalAnswers(student, reference)).toBe('not_equal');
  });

  it.each([
    ['y+1', 'x+1'],
    ['2m/s', '2'],
    ['(1,2)', '(2,1)'],
    ['x+', 'x'],
    ['\\int_0^1 x dx', '1/2'],
    ['x=1 或 x=2', 'x=1'],
  ])('%s against %s is left to the model', async (student, reference) => {
    expect(await compareFinalAnswers(student, reference)).toBe('unknown');
  });
});
