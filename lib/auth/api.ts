import { AuthError, authJsonResponse } from './errors';
import { isHostedAuthEnabled } from './mode';
import type { Principal } from './principal';
import { requirePrincipal, tryPrincipal } from './session';
import { withProviderQuotaOwner } from '@/lib/server/generation-jobs/provider-call-context';

export async function withApiPrincipal(
  request: Request,
  handler: (principal: Principal, headers: Headers) => Promise<Response>,
): Promise<Response> {
  const headers = new Headers({ 'Cache-Control': 'private, no-store' });
  try {
    const principal = await requirePrincipal(request, headers);
    const response = await withProviderQuotaOwner(principal.ownerId, () =>
      handler(principal, headers),
    );
    for (const [name, value] of headers.entries()) {
      if (!response.headers.has(name)) response.headers.set(name, value);
    }
    return response;
  } catch (error) {
    if (error instanceof AuthError) return authJsonResponse(error, headers);
    throw error;
  }
}

/**
 * Hosted mode (`AUTH_MODE=supabase`) requires a verified principal.
 * Dual-mode returns the session principal when one exists, otherwise null
 * so unsigned/dev-token callers keep working.
 */
export async function requirePrincipalIfHosted(
  request: Request,
  responseHeaders?: Headers,
): Promise<Principal | Response | null> {
  if (isHostedAuthEnabled()) {
    try {
      return await requirePrincipal(request, responseHeaders);
    } catch (error) {
      if (error instanceof AuthError) return authJsonResponse(error, responseHeaders);
      throw error;
    }
  }
  try {
    return (await tryPrincipal(request, responseHeaders)) ?? null;
  } catch (error) {
    if (error instanceof AuthError) return authJsonResponse(error, responseHeaders);
    throw error;
  }
}

export function unauthorizedJson(headers?: Headers): Response {
  return authJsonResponse(new AuthError('UNAUTHENTICATED'), headers);
}

/** Returns a 401/503 response when hosted auth is on and the session is missing. */
export async function hostedAuthGate(request: Request): Promise<Response | null> {
  const result = await requirePrincipalIfHosted(request);
  if (result instanceof Response) return result;
  return null;
}

/** Bind classroom SDK calls to verified identity for their full asynchronous lifetime. */
export async function withHostedProviderQuota(
  request: Request,
  handler: () => Promise<Response>,
): Promise<Response> {
  const principal = await requirePrincipalIfHosted(request);
  if (principal instanceof Response) return principal;
  return principal ? withProviderQuotaOwner(principal.ownerId, handler) : handler();
}
