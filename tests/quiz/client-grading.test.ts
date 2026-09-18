import { describe, expect, it } from 'vitest';
import { mapWithConcurrency, parseQuizGradeResponse } from '@/lib/quiz/client-grading';

describe('quiz client grading', () => {
  it('never runs more than two short-answer grading operations concurrently', async () => {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const work = mapWithConcurrency([1, 2, 3, 4], 2, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return value * 10;
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(active).toBe(2);
    releases.shift()!();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    releases.shift()!();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    releases.shift()!();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    releases.shift()!();

    await expect(work).resolves.toEqual([10, 20, 30, 40]);
    expect(peak).toBe(2);
  });

  it('rejects an invalid successful response instead of coercing a score', () => {
    expect(() => parseQuizGradeResponse({ success: true, score: '1', comment: 'ok' }, 2)).toThrow(
      'Invalid quiz grade response',
    );
  });
});
