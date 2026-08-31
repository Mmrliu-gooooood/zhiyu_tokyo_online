import { describe, expect, it } from 'vitest';
import { DEFAULT_BRAND } from '@/lib/brand/brand-config';

describe('DEFAULT_BRAND (single-brand build)', () => {
  it('uses the ZHIYU product identity for full chrome', () => {
    expect(DEFAULT_BRAND.productName).toBe('智域');
    expect(DEFAULT_BRAND.shortName).toBe('智域');
    expect(DEFAULT_BRAND.markSrc).toBe('/zhiyu-mark.svg');
    expect(DEFAULT_BRAND.themeColor).toBe('#356B59');
  });

  it('marks its horizontal logo as already containing the wordmark', () => {
    expect(DEFAULT_BRAND.logoHasWordmark).toBe(true);
    expect(DEFAULT_BRAND.logoSrc).toBe('/zhiyu-lockup.svg');
  });
});
