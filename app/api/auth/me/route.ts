import { AuthError, authJsonResponse } from '@/lib/auth/errors';
import { canUseHostedAuthUi } from '@/lib/auth/mode';
import { requirePrincipal } from '@/lib/auth/session';
import { getPersistencePool } from '@/lib/db/pool-registry';
import { createOwnerBoundQueryable } from '@/lib/db/request-queryable';
import type { Pool } from 'pg';

export const dynamic = 'force-dynamic';

function pool(): Pool | undefined {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) return undefined;
  return getPersistencePool();
}

export async function GET(request: Request) {
  const headers = new Headers({ 'Cache-Control': 'private, no-store' });
  if (!canUseHostedAuthUi()) {
    return authJsonResponse(new AuthError('UNAUTHENTICATED', 'Hosted auth is not enabled'), headers);
  }
  try {
    const principal = await requirePrincipal(request, headers);
    let displayName: string | null = null;
    try {
      const db = pool();
      const result = db
        ? await createOwnerBoundQueryable(db, principal.ownerId).query<{
            display_name: string | null;
          }>('SELECT display_name FROM app_profiles WHERE user_id = $1', [principal.userId])
        : undefined;
      displayName = result?.rows[0]?.display_name ?? null;
    } catch {
      displayName = principal.email.split('@')[0] ?? null;
    }
    return Response.json(
      {
        userId: principal.userId,
        ownerId: principal.ownerId,
        learnerKey: principal.learnerKey,
        sessionId: principal.sessionId,
        email: principal.email,
        role: principal.role,
        displayName,
        status: principal.status,
      },
      { headers },
    );
  } catch (error) {
    if (error instanceof AuthError) return authJsonResponse(error, headers);
    throw error;
  }
}
