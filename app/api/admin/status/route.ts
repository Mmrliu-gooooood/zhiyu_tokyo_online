import { AuthError, authJsonResponse } from '@/lib/auth/errors';
import { requireAdmin } from '@/lib/auth/principal';
import { requirePrincipal } from '@/lib/auth/session';
import { getPersistencePool } from '@/lib/db/pool-registry';
import { generationRequestReadiness } from '@/lib/server/generation-jobs/runtime';
import type { Pool } from 'pg';

export const dynamic = 'force-dynamic';

function pool(): Pool | undefined {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) return undefined;
  return getPersistencePool();
}

export async function GET(request: Request) {
  const headers = new Headers({ 'Cache-Control': 'private, no-store' });
  try {
    const principal = await requirePrincipal(request, headers);
    requireAdmin(principal);
    const readiness = await generationRequestReadiness();
    let accountCount: number | null = null;
    try {
      const result = await pool()?.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM app_accounts',
      );
      accountCount = result?.rows[0]?.count ? Number(result.rows[0].count) : null;
    } catch {
      accountCount = null;
    }
    return Response.json(
      {
        role: principal.role,
        readiness: {
          database: readiness.database,
          schema: readiness.schema,
          worker: readiness.worker,
          accepting: readiness.accepting,
        },
        accountCount,
      },
      { headers },
    );
  } catch (error) {
    if (error instanceof AuthError) return authJsonResponse(error, headers);
    throw error;
  }
}
