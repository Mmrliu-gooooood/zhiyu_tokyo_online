/**
 * Pure media-reference check shared by the browser store and server code.
 * Kept free of client state (zustand / Dexie / i18n) so server bundles that
 * need it never load the browser media store.
 */
const CONCRETE_URL = /^(https?:|data:|blob:|\/|\.\.?\/)/i;

/** Check whether a media reference still needs resolution before rendering. */
export function isMediaPlaceholder(src: string): boolean {
  return !!src && !CONCRETE_URL.test(src);
}
