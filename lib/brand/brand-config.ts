/**
 * Brand configuration.
 *
 * The reference (live deployment) resolves the brand per vendor from the
 * desktop shell's User-Agent token. This workspace has no vendor shell: the
 * product ships with its own single brand, so the config is static and the
 * desktop flag is always off. The shape is kept so surfaces that read the
 * brand (home hero, workspace rail, site header) keep one source of truth.
 */

export interface BrandConfig {
  /** Full product name (page titles, logo alt text). */
  productName: string;
  /** Short name for space-constrained spots. */
  shortName: string;
  /** Horizontal logo asset under `public/`. */
  logoSrc: string;
  /** Whether `logoSrc` already carries the product wordmark. */
  logoHasWordmark: boolean;
  /** Square brand mark under `public/` (favicon, workspace header). */
  markSrc: string;
  /** Browser theme color (`<meta name="theme-color">` / PWA). */
  themeColor: string;
}

/** English companion used by the bilingual product lockup. */
export const BRAND_ENGLISH_NAME = 'ZHIYU';

/** The default brand: the product itself, with no vendor overrides. */
export const DEFAULT_BRAND: BrandConfig = {
  productName: '智域',
  shortName: '智域',
  logoSrc: '/zhiyu-lockup.svg',
  logoHasWordmark: true,
  markSrc: '/zhiyu-mark.svg',
  themeColor: '#356B59',
};
