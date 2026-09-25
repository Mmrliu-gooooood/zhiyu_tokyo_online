import {
  resolveGenerationOwner,
  resolveGenerationOwnerAsync,
} from '@/lib/server/generation-jobs/auth';
import { isHostedAuthEnabled } from '@/lib/auth/mode';

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

export async function resolveRequestOwnerIdAsync(
  req: Pick<Request, 'headers'> & Partial<Pick<Request, 'url'>>,
  responseHeaders: Headers,
  authenticatedOwnerId?: string,
): Promise<string> {
  if (authenticatedOwnerId) return authenticatedOwnerId;
  // Hosted identity ignores anonymous cookies. Keep the original request so
  // its verified principal (and client binding) is reused within this request.
  if (isHostedAuthEnabled() && req instanceof Request) {
    return resolveGenerationOwnerAsync(req, responseHeaders, true);
  }
  const headers = new Headers(req.headers);
  headers.set(
    'cookie',
    (headers.get('cookie') ?? '')
      .split(';')
      .filter((part) => part.trim().split('=')[0] !== 'anonymous_id')
      .join(';'),
  );
  return resolveGenerationOwnerAsync(
    new Request(req.url ?? 'http://localhost:3000', { headers }),
    responseHeaders,
    true,
  );
}
