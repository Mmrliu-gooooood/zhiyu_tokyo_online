/** Structured diagnostics only: never copy upstream messages, bodies, URLs or queries into logs. */
export class WebSearchHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly mode: 'api' | 'public_html',
  ) {
    super(message);
    this.name = 'WebSearchHttpError';
  }
}

export function describeWebSearchFailure(error: unknown): {
  reason: string;
  status?: number;
  mode?: 'api' | 'public_html';
  action?: string;
} {
  if (error instanceof WebSearchHttpError) {
    const { status, mode } = error;
    return {
      reason:
        status === 429
          ? 'rate_limited'
          : status === 401
            ? 'authentication_failed'
            : status === 403
              ? 'access_denied'
              : 'upstream_http_error',
      status,
      mode,
      ...(mode === 'public_html' && (status === 429 || status === 403)
        ? { action: 'Configure a valid search API key in Web Search settings' }
        : {}),
    };
  }

  let current = error;
  for (let depth = 0; depth < 3 && current && typeof current === 'object'; depth++) {
    const value = current as { code?: unknown; name?: unknown; cause?: unknown };
    if (value.code === 'ENOTFOUND' || value.code === 'EAI_AGAIN') return { reason: 'dns_failure' };
    if (value.name === 'TimeoutError' || value.code === 'UND_ERR_CONNECT_TIMEOUT') {
      return { reason: 'timeout' };
    }
    if (value.code === 'ECONNRESET' || value.code === 'ECONNREFUSED') {
      return { reason: 'connection_failure' };
    }
    current = value.cause;
  }
  return { reason: 'provider_error' };
}
