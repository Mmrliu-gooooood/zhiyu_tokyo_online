const AUTH_LOOP_PREFIXES = ['/auth/', '/api/auth/'];

function decodeUntilStable(value: string, rounds = 3): string {
  let current = value;
  for (let i = 0; i < rounds; i += 1) {
    try {
      const next = decodeURIComponent(current);
      if (next === current) return next;
      current = next;
    } catch {
      return current;
    }
  }
  return current;
}

/**
 * Only in-app paths are allowed as `next`. External hosts, protocol-relative
 * URLs, backslashes, and encoded bypasses are rejected.
 */
export function safeNextPath(raw: string | null | undefined, fallback = '/'): string {
  if (!raw) return fallback;
  const decoded = decodeUntilStable(raw.trim());
  if (!decoded.startsWith('/')) return fallback;
  if (decoded.startsWith('//')) return fallback;
  if (decoded.includes('\\') || decoded.includes('\0')) return fallback;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(decoded)) return fallback;
  const pathOnly = decoded.split('#')[0] ?? decoded;
  const normalized = pathOnly.replace(/\/{2,}/g, '/');
  if (AUTH_LOOP_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix))) {
    return fallback;
  }
  if (normalized.length > 512) return fallback;
  return normalized || fallback;
}

export function appOrigin(): string {
  const origin = process.env.APP_ORIGIN?.trim();
  if (origin) return origin.replace(/\/+$/, '');
  return 'http://localhost:3000';
}
