/**
 * Shared guard for the credential and sign-in APIs (plan 3.10): the
 * deployment must be able to hold credentials, the request owner comes from
 * the hosted session (withRequestOwnerId also checks the request origin),
 * responses are never cached, and errors carry fixed codes only.
 */
import { createLogger } from '@/lib/logger';
import { oauthDeploymentCapable } from '@/lib/model-gateway/auth/policy';
import { LoginSessionError } from '@/lib/model-gateway/auth/login-sessions';
import { isCredentialVaultError, type VaultErrorCode } from '@/lib/model-gateway/credentials/vault';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';

const log = createLogger('ModelAuthRoute');

const VAULT_STATUS: Partial<Record<VaultErrorCode, number>> = {
  MODEL_CREDENTIAL_NOT_FOUND: 404,
  MODEL_CREDENTIAL_BUSY: 409,
  MODEL_CREDENTIAL_VAULT_UNAVAILABLE: 503,
};

export const MAX_MODEL_AUTH_BODY = 8192;

export async function modelAuthRoute(
  req: Request,
  handler: (ownerId: string, headers: Headers) => Promise<Response>,
): Promise<Response> {
  if (!oauthDeploymentCapable()) {
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
  return withRequestOwnerId(req, async (ownerId, headers) => {
    headers.set('Cache-Control', 'no-store');
    try {
      return await handler(ownerId, headers);
    } catch (error) {
      if (error instanceof LoginSessionError) {
        return Response.json({ error: error.code }, { status: error.status, headers });
      }
      if (isCredentialVaultError(error)) {
        return Response.json(
          { error: error.code },
          { status: VAULT_STATUS[error.code] ?? 409, headers },
        );
      }
      log.error('model auth request failed', {
        name: error instanceof Error ? error.name : typeof error,
      });
      return Response.json({ error: 'MODEL_AUTH_UNAVAILABLE' }, { status: 503, headers });
    }
  });
}

/** A small JSON object body, or undefined when absent, oversized or malformed. */
export async function readSmallJsonObject(
  req: Request,
): Promise<Record<string, unknown> | undefined> {
  if (Number(req.headers.get('content-length') ?? 0) > MAX_MODEL_AUTH_BODY) return undefined;
  const raw = await req.text();
  if (raw.length > MAX_MODEL_AUTH_BODY) return undefined;
  try {
    const value: unknown = raw ? JSON.parse(raw) : {};
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
