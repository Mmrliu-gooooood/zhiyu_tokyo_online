import { AuthError, authJsonResponse } from '@/lib/auth/errors';
import { canUseHostedAuthUi } from '@/lib/auth/mode';
import { assertSameAppOrigin } from '@/lib/auth/origin';
import { requirePrincipal } from '@/lib/auth/session';
import { getPersistencePool } from '@/lib/db/pool-registry';
import { createOwnerBoundQueryable } from '@/lib/db/request-queryable';

export const ALLOWED_ACCOUNT_KV_KEYS = [
  'settings.ui',
  'settings.locale',
  'profile.displayName',
  'workspace.tabs',
] as const;

const allowedKeys = new Set<string>(ALLOWED_ACCOUNT_KV_KEYS);

function responseHeaders(): Headers {
  return new Headers({ 'Cache-Control': 'private, no-store' });
}

export function assertAccountKvKey(key: string): void {
  if (!allowedKeys.has(key)) {
    throw new AuthError('INVALID_REQUEST', 'KV key is not allowed');
  }
}

function protocolError(status: number, code: string, message: string, headers: Headers): Response {
  return Response.json({ error: { code, message } }, { status, headers });
}

export async function readAccountKvEntry(request: Request, key: string): Promise<Response> {
  const headers = responseHeaders();
  if (!canUseHostedAuthUi()) {
    return protocolError(401, 'UNAUTHENTICATED', 'Hosted auth is not enabled', headers);
  }
  try {
    assertAccountKvKey(key);
    const principal = await requirePrincipal(request, headers);
    const result = await createOwnerBoundQueryable(getPersistencePool(), principal.ownerId).query<{
      value: unknown;
    }>('SELECT value FROM account_kv WHERE owner_id = $1 AND key = $2', [principal.ownerId, key]);
    if (result.rows.length === 0) {
      return protocolError(
        404,
        'KEY_NOT_FOUND',
        'No account value is stored for this key',
        headers,
      );
    }
    return Response.json({ value: result.rows[0]?.value ?? null }, { headers });
  } catch (error) {
    if (error instanceof AuthError) return authJsonResponse(error, headers);
    throw error;
  }
}

export async function listAccountKvKeys(request: Request): Promise<Response> {
  const headers = responseHeaders();
  if (!canUseHostedAuthUi()) {
    return protocolError(401, 'UNAUTHENTICATED', 'Hosted auth is not enabled', headers);
  }
  try {
    const url = new URL(request.url);
    if (url.searchParams.has('scope')) {
      return protocolError(400, 'VALIDATION_FAILED', 'Account KV does not accept a scope', headers);
    }
    const prefix = url.searchParams.get('prefix') ?? '';
    const principal = await requirePrincipal(request, headers);
    const result = await createOwnerBoundQueryable(getPersistencePool(), principal.ownerId).query<{
      key: string;
    }>('SELECT key FROM account_kv WHERE owner_id = $1 AND key = ANY($2::text[]) ORDER BY key', [
      principal.ownerId,
      [...ALLOWED_ACCOUNT_KV_KEYS],
    ]);
    return Response.json(
      result.rows.map(({ key }) => key).filter((key) => key.startsWith(prefix)),
      { headers },
    );
  } catch (error) {
    if (error instanceof AuthError) return authJsonResponse(error, headers);
    throw error;
  }
}

export async function writeAccountKvEntry(request: Request, key: string): Promise<Response> {
  const headers = responseHeaders();
  if (!canUseHostedAuthUi()) {
    return protocolError(401, 'UNAUTHENTICATED', 'Hosted auth is not enabled', headers);
  }
  try {
    assertSameAppOrigin(request);
    assertAccountKvKey(key);
    const body = (await request.json()) as Record<string, unknown>;
    if (
      typeof body !== 'object' ||
      body === null ||
      !Object.prototype.hasOwnProperty.call(body, 'value') ||
      Object.prototype.hasOwnProperty.call(body, 'scope')
    ) {
      return protocolError(
        400,
        'VALIDATION_FAILED',
        'KV write body must carry value only',
        headers,
      );
    }
    let encoded: string | undefined;
    try {
      encoded = JSON.stringify(body.value);
    } catch {
      encoded = undefined;
    }
    if (encoded === undefined) {
      return protocolError(400, 'VALIDATION_FAILED', 'KV value must be valid JSON', headers);
    }
    if (Buffer.byteLength(encoded, 'utf8') > 16_384) {
      return protocolError(413, 'PAYLOAD_TOO_LARGE', 'KV value is too large', headers);
    }
    const principal = await requirePrincipal(request, headers);
    await createOwnerBoundQueryable(getPersistencePool(), principal.ownerId).query(
      `INSERT INTO account_kv (owner_id, key, value, version, updated_at)
       VALUES ($1, $2, $3::jsonb, 1, clock_timestamp())
       ON CONFLICT (owner_id, key) DO UPDATE
       SET value = EXCLUDED.value, version = account_kv.version + 1, updated_at = clock_timestamp()`,
      [principal.ownerId, key, encoded],
    );
    return new Response(null, { status: 204, headers });
  } catch (error) {
    if (error instanceof AuthError) return authJsonResponse(error, headers);
    throw error;
  }
}

export async function deleteAccountKvEntry(request: Request, key: string): Promise<Response> {
  const headers = responseHeaders();
  if (!canUseHostedAuthUi()) {
    return protocolError(401, 'UNAUTHENTICATED', 'Hosted auth is not enabled', headers);
  }
  try {
    assertSameAppOrigin(request);
    assertAccountKvKey(key);
    const principal = await requirePrincipal(request, headers);
    await createOwnerBoundQueryable(getPersistencePool(), principal.ownerId).query(
      'DELETE FROM account_kv WHERE owner_id = $1 AND key = $2',
      [principal.ownerId, key],
    );
    return new Response(null, { status: 204, headers });
  } catch (error) {
    if (error instanceof AuthError) return authJsonResponse(error, headers);
    throw error;
  }
}
