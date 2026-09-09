import { resolveGenerationOwner } from '@/lib/server/generation-jobs/auth';

/** Signed identity shared by sessions and credentials, independent of job flags. */
export function resolveRequestOwnerId(
  req: Pick<Request, 'headers'> & Partial<Pick<Request, 'url'>>,
  responseHeaders: Headers,
  authenticatedOwnerId?: string,
): string {
  if (authenticatedOwnerId) return authenticatedOwnerId;
  const headers = new Headers(req.headers);
  // Never import an unsigned UUID, even when legacy generation migration is on.
  // Legacy data can only be reassigned by an explicitly trusted local operator.
  headers.set(
    'cookie',
    (headers.get('cookie') ?? '')
      .split(';')
      .filter((part) => part.trim().split('=')[0] !== 'anonymous_id')
      .join(';'),
  );
  return resolveGenerationOwner(
    new Request(req.url ?? 'http://localhost:3000', { headers }),
    responseHeaders,
    true,
  );
}
