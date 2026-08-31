import { describe, expect, it } from 'vitest';
import { projectAccessCodeVisualState } from '@/lib/access-code/presentation';

describe('projectAccessCodeVisualState', () => {
  it('projects every access-code surface state without owning verification', () => {
    expect(projectAccessCodeVisualState({ error: '', loading: false, success: false })).toBe(
      'initial',
    );
    expect(
      projectAccessCodeVisualState({ error: 'invalid', loading: false, success: false }),
    ).toBe('invalid');
    expect(projectAccessCodeVisualState({ error: '', loading: true, success: false })).toBe(
      'loading',
    );
    expect(projectAccessCodeVisualState({ error: '', loading: false, success: true })).toBe(
      'success',
    );
  });

  it('keeps success and loading deterministic while async flags settle', () => {
    expect(projectAccessCodeVisualState({ error: 'stale', loading: true, success: false })).toBe(
      'loading',
    );
    expect(projectAccessCodeVisualState({ error: 'stale', loading: true, success: true })).toBe(
      'success',
    );
  });
});
