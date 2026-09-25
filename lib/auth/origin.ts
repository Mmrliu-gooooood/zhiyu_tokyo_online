import { AuthError } from './errors';
import { appOrigin } from './safe-next';

/** Mutation requests must come from the configured site origin. */
export function assertSameAppOrigin(request: Request): void {
  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') {
    return;
  }
  const allowed = appOrigin();
  const origin = request.headers.get('origin');
  if (!origin || origin !== allowed) {
    throw new AuthError('FORBIDDEN', 'Request origin is not allowed');
  }
}
