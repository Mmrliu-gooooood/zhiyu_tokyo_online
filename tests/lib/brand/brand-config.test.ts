import { describe, expect, it } from 'vitest';
import { DEFAULT_BRAND } from '@/lib/brand/brand-config';

describe('DEFAULT_BRAND (single-brand build)', () => {
  it('uses the Qingjin product identity for full chrome', () => {
    expect(DEFAULT_BRAND.productName).toBe('青衿');
    expect(DEFAULT_BRAND.shortName).toBe('青衿');
    expect(DEFAULT_BRAND.markSrc).toBe('/qingjin-mark.svg');
    expect(DEFAULT_BRAND.themeColor).toBe('#3D6B5A');
  });

  it('marks its horizontal logo as already containing the wordmark', () => {
    expect(DEFAULT_BRAND.logoHasWordmark).toBe(true);
    expect(DEFAULT_BRAND.logoSrc).toBe('/qingjin-lockup.svg');
  });
});
