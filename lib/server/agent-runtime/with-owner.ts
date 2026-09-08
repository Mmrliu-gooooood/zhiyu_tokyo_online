import { resolveRequestOwnerId } from './owner';
import { assertGenerationOrigin } from '@/lib/server/generation-jobs/auth';
import { GenerationJobError } from '@/lib/server/generation-jobs/contracts';

/**
 * Resolve the anonymous owner identity and run a handler with its response
 * headers.
 *
 * The Set-Cookie minted by resolveRequestOwnerId must ride every response,
 * including 4xx and 5xx: a client that retries after an error keeps the same
 * owner partition, while a 500 that dropped the cookie would silently make
 * the retry a different anonymous owner.
 */
export async function withRequestOwnerId(
  req: Pick<Request, 'headers'> & Partial<Pick<Request, 'url' | 'method'>>,
  handler: (ownerId: string, responseHeaders: Headers) => Promise<Response>,
): Promise<Response> {
  const responseHeaders = new Headers();
  try {
    if (req.url && req.method) assertGenerationOrigin(req as Request);
    const ownerId = resolveRequestOwnerId(req, responseHeaders);
    return await handler(ownerId, responseHeaders);
  } catch (error) {
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
    console.error('[agent-runtime] request failed under a signed owner');
    return new Response('Internal Server Error', { status: 500, headers: responseHeaders });
  }
}
