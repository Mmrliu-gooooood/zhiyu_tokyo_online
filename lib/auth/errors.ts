export type AuthFailureCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'AUTH_UNAVAILABLE'
  | 'ACCOUNT_DISABLED'
  | 'SESSION_REVOKED'
  | 'SHARING_DISABLED'
  | 'RATE_LIMITED'
  | 'INVALID_REQUEST';

const STATUS: Record<AuthFailureCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  AUTH_UNAVAILABLE: 503,
  ACCOUNT_DISABLED: 403,
  SESSION_REVOKED: 401,
  SHARING_DISABLED: 403,
  RATE_LIMITED: 429,
  INVALID_REQUEST: 400,
};

export class AuthError extends Error {
  readonly code: AuthFailureCode;
  readonly httpStatus: number;

  constructor(code: AuthFailureCode, message?: string) {
    super(message ?? code);
    this.name = 'AuthError';
    this.code = code;
    this.httpStatus = STATUS[code];
  }
}

export function authJsonResponse(error: AuthError, headers?: Headers): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Cache-Control', 'private, no-store');
  if (error.httpStatus === 503 || error.httpStatus === 429) {
    responseHeaders.set('Retry-After', '10');
  }
  return Response.json(
    { success: false, errorCode: error.code, error: error.message },
    { status: error.httpStatus, headers: responseHeaders },
  );
}
