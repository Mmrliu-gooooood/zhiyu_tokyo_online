import { AuthError, authJsonResponse } from '@/lib/auth/errors';
import { resolveRequestOwnerIdAsync } from './owner';
import { assertGenerationOrigin } from '@/lib/server/generation-jobs/auth';
import { GenerationJobError } from '@/lib/server/generation-jobs/contracts';
import { withProviderQuotaOwner } from '@/lib/server/generation-jobs/provider-call-context';

/** Fixed diagnostic labels only: upstream messages can contain URLs or secrets. */
function safeRequestFailure(error: unknown): { category: string; code?: string } {
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : '';
  if (code === 'EAI_AGAIN' || code === 'ENOTFOUND') return { category: 'dns', code };
  if (
    code === 'ETIMEDOUT' ||
    (error instanceof Error && /timeout|timed out/i.test(error.message))
  ) {
    return { category: 'timeout' };
  }
  if (/^(?:[0-9]{2}[0-9A-Z]{3}|XX[0-9]{3}|P0[0-9]{3})$/.test(code)) {
    return { category: 'sqlstate', code };
  }
  if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'EPIPE') {
    return { category: 'connection', code };
  }
  return { category: 'unknown' };
}

/**
 * Resolve the request owner (hosted principal, or signed anonymous cookie in
 * legacy mode) and run a handler with its response headers.
 *
 * In legacy mode the Set-Cookie minted by resolveRequestOwnerId must ride
 * every response, including 4xx and 5xx: a client that retries after an error
 * keeps the same owner partition. Hosted mode does not mint anonymous owners.
 */
export async function withRequestOwnerId(
  req: Pick<Request, 'headers'> & Partial<Pick<Request, 'url' | 'method'>>,
  handler: (ownerId: string, responseHeaders: Headers) => Promise<Response>,
): Promise<Response> {
  const responseHeaders = new Headers();
  try {
    if (req.url && req.method) assertGenerationOrigin(req as Request);
    const ownerId = await resolveRequestOwnerIdAsync(req, responseHeaders);
    return await withProviderQuotaOwner(ownerId, () => handler(ownerId, responseHeaders));
  } catch (error) {
    if (error instanceof AuthError) return authJsonResponse(error, responseHeaders);
    if (error instanceof GenerationJobError) {
      return Response.json(
        { error: error.code },
        { status: error.httpStatus, headers: responseHeaders },
      );
    }
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string' &&
      /^PRO_MODEL_[A-Z_]+$/.test(error.code)
    ) {
      const status =
        'status' in error &&
        typeof error.status === 'number' &&
        error.status >= 400 &&
        error.status <= 599
          ? error.status
          : 400;
      return Response.json({ error: error.code }, { status, headers: responseHeaders });
    }
    // Arbitrary upstream exceptions may include connection secrets.
    console.error('[agent-runtime] request failed under a signed owner', safeRequestFailure(error));
    return new Response('Internal Server Error', { status: 500, headers: responseHeaders });
  }
}
