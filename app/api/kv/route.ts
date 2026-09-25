import { AuthError, authJsonResponse } from '@/lib/auth/errors';
import { canUseHostedAuthUi } from '@/lib/auth/mode';
import { assertSameAppOrigin } from '@/lib/auth/origin';
import { requirePrincipal } from '@/lib/auth/session';
import { getPersistencePool } from '@/lib/db/pool-registry';
import { createOwnerBoundQueryable } from '@/lib/db/request-queryable';

import { assertAccountKvKey } from './handler';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const headers = new Headers({ 'Cache-Control': 'private, no-store' });
  if (!canUseHostedAuthUi()) {
    return authJsonResponse(new AuthError('UNAUTHENTICATED'), headers);
  }
  try {
    const principal = await requirePrincipal(request, headers);
    const url = new URL(request.url);
    const key = url.searchParams.get('key') ?? '';
    assertAccountKvKey(key);
    const result = await createOwnerBoundQueryable(getPersistencePool(), principal.ownerId).query<{
      value: unknown;
    }>('SELECT value FROM account_kv WHERE owner_id = $1 AND key = $2', [principal.ownerId, key]);
    return Response.json({ key, value: result.rows[0]?.value ?? null }, { headers });
  } catch (error) {
    if (error instanceof AuthError) return authJsonResponse(error, headers);
    throw error;
  }
}

export async function PUT(request: Request) {
  const headers = new Headers({ 'Cache-Control': 'private, no-store' });
  if (!canUseHostedAuthUi()) {
    return authJsonResponse(new AuthError('UNAUTHENTICATED'), headers);
  }
  try {
    assertSameAppOrigin(request);
    const principal = await requirePrincipal(request, headers);
    const body = (await request.json()) as { key?: unknown; value?: unknown };
    if (typeof body.key !== 'string') throw new AuthError('INVALID_REQUEST');
    assertAccountKvKey(body.key);
    const encoded = JSON.stringify(body.value);
    if (encoded === undefined) throw new AuthError('INVALID_REQUEST', 'KV value must be valid JSON');
    if (Buffer.byteLength(encoded, 'utf8') > 16_384) {
      throw new AuthError('INVALID_REQUEST', 'KV value is too large');
    }
    await createOwnerBoundQueryable(getPersistencePool(), principal.ownerId).query(
      `INSERT INTO account_kv (owner_id, key, value, version, updated_at)
       VALUES ($1, $2, $3::jsonb, 1, clock_timestamp())
       ON CONFLICT (owner_id, key) DO UPDATE
       SET value = EXCLUDED.value, version = account_kv.version + 1, updated_at = clock_timestamp()`,
      [principal.ownerId, body.key, encoded],
    );
    return Response.json({ success: true }, { headers });
  } catch (error) {
    if (error instanceof AuthError) return authJsonResponse(error, headers);
    throw error;
  }
}
