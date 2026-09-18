import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getLearningUiCapabilities,
  isGuidedLearningEnabled,
  isLearningChecksEnabled,
} from '@/lib/learning/feature-flags';

describe('learning feature flags', () => {
  const keys = [
    'NEXT_PUBLIC_LEARNING_CHECKS_ENABLED',
    'NEXT_PUBLIC_GUIDED_LEARNING_ENABLED',
  ] as const;
  const originals = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of keys) {
      originals.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of keys) {
      const original = originals.get(key);
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
    originals.clear();
  });

  it('keeps both capabilities independently disabled by default', () => {
    expect(isLearningChecksEnabled()).toBe(false);
    expect(isGuidedLearningEnabled()).toBe(false);

    process.env.NEXT_PUBLIC_LEARNING_CHECKS_ENABLED = '1';
    expect(isLearningChecksEnabled()).toBe(true);
    expect(isGuidedLearningEnabled()).toBe(false);

    delete process.env.NEXT_PUBLIC_LEARNING_CHECKS_ENABLED;
    process.env.NEXT_PUBLIC_GUIDED_LEARNING_ENABLED = 'true';
    expect(isLearningChecksEnabled()).toBe(false);
    expect(isGuidedLearningEnabled()).toBe(true);
  });

  it.each([
    {
      checks: false,
      guided: false,
      expected: { showChecks: false, showQuizRemediation: false, allowGuidedDiscussion: false },
    },
    {
      checks: true,
      guided: false,
      expected: { showChecks: true, showQuizRemediation: true, allowGuidedDiscussion: false },
    },
    {
      checks: false,
      guided: true,
      expected: { showChecks: false, showQuizRemediation: false, allowGuidedDiscussion: false },
    },
    {
      checks: true,
      guided: true,
      expected: { showChecks: true, showQuizRemediation: true, allowGuidedDiscussion: true },
    },
  ])(
    'keeps checks and guided discussion independent for $checks/$guided',
    ({ checks, guided, expected }) => {
      expect(getLearningUiCapabilities(checks, guided)).toEqual(expected);
    },
  );
});
