const PUBLIC_EXACT = new Set([
  '/auth/login',
  '/auth/sign-up',
  '/auth/signup',
  '/auth/check-email',
  '/auth/forgot-password',
  '/auth/update-password',
  '/auth/error',
  '/auth/confirm',
  '/api/health',
  '/api/health/ready',
  '/api/access-code/status',
  '/api/access-code/verify',
  '/api/auth/resend',
]);

/** Login / signup URLs that a signed-in session should leave. */
const AUTH_SESSION_ENTRY = new Set(['/auth/login', '/auth/sign-up', '/auth/signup']);

const PUBLIC_PREFIXES = ['/auth/', '/api/auth/confirm', '/_next/', '/favicon.ico', '/logos/', '/avatars/'];

export function isPublicAuthPath(pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix));
}

export function isAuthPagePath(pathname: string): boolean {
  return pathname === '/auth' || pathname.startsWith('/auth/');
}

export function isAuthSessionEntryPath(pathname: string): boolean {
  return AUTH_SESSION_ENTRY.has(pathname);
}

/** Docker probes `/api/health/ready`; neither route returns user data. */
export function isMinimalHealthPath(pathname: string): boolean {
  return pathname === '/api/health' || pathname === '/api/health/ready';
}
