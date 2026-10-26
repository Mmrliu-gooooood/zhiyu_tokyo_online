/** The product introduction signed-out visitors see instead of the app. */
export const LANDING_PATH = '/welcome';

const PUBLIC_EXACT = new Set([
  LANDING_PATH,
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

/** Landing / login / signup URLs that a signed-in session should leave. */
const AUTH_SESSION_ENTRY = new Set([LANDING_PATH, '/auth/login', '/auth/sign-up', '/auth/signup']);

const PUBLIC_PREFIXES = [
  '/auth/',
  '/api/auth/confirm',
  '/_next/',
  '/favicon.ico',
  '/logos/',
  '/avatars/',
];

export function isPublicAuthPath(pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix));
}

export function isAuthPagePath(pathname: string): boolean {
  return pathname === '/auth' || pathname.startsWith('/auth/');
}

/** Pages that render without an account: the auth flow and the landing page. */
export function isSessionFreePagePath(pathname: string): boolean {
  return pathname === LANDING_PATH || isAuthPagePath(pathname);
}

export function isAuthSessionEntryPath(pathname: string): boolean {
  return AUTH_SESSION_ENTRY.has(pathname);
}

/** Docker probes `/api/health/ready`; neither route returns user data. */
export function isMinimalHealthPath(pathname: string): boolean {
  return pathname === '/api/health' || pathname === '/api/health/ready';
}
