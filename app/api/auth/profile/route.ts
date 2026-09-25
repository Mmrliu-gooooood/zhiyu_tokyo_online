import { AuthError, authJsonResponse } from '@/lib/auth/errors';
import { canUseHostedAuthUi } from '@/lib/auth/mode';
import { assertSameAppOrigin } from '@/lib/auth/origin';
import { requirePrincipal } from '@/lib/auth/session';
import { getPersistencePool } from '@/lib/db/pool-registry';
import { createOwnerBoundQueryable } from '@/lib/db/request-queryable';
import type { Pool } from 'pg';

export const dynamic = 'force-dynamic';

const DISPLAY_NAME = /^[\p{L}\p{N} ._'-]{1,64}$/u;

function pool(): Pool | undefined {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) return undefined;
  return getPersistencePool();
}

export async function PATCH(request: Request) {
  const headers = new Headers({ 'Cache-Control': 'private, no-store' });
  if (!canUseHostedAuthUi()) {
    return authJsonResponse(new AuthError('UNAUTHENTICATED', 'Hosted auth is not enabled'), headers);
  }
  try {
    assertSameAppOrigin(request);
    const principal = await requirePrincipal(request, headers);
    const body = (await request.json()) as { displayName?: unknown };
    if (typeof body.displayName !== 'string' || !DISPLAY_NAME.test(body.displayName.trim())) {
      throw new AuthError('INVALID_REQUEST', 'Display name is invalid');
    }
    const displayName = body.displayName.trim();
    const db = pool();
    if (!db) throw new AuthError('AUTH_UNAVAILABLE', 'Account registry is unavailable');
    const ownerDb = createOwnerBoundQueryable(db, principal.ownerId);
    await ownerDb.query(
      `INSERT INTO app_profiles (user_id, display_name, updated_at)
       VALUES ($1, $2, clock_timestamp())
       ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = clock_timestamp()`,
      [principal.userId, displayName],
    );
    return Response.json({ success: true, displayName }, { headers });
  } catch (error) {
    if (error instanceof AuthError) return authJsonResponse(error, headers);
    throw error;
  }
}
