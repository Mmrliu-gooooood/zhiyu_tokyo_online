import type { Pool } from 'pg';

import { AuthError } from '@/lib/auth/errors';
import { getPersistencePool } from '@/lib/db/pool-registry';
import {
  createPrincipal,
  type AccountStatus,
  type AppRole,
  type Principal,
} from '@/lib/auth/principal';
import { AUTH_EPOCH_HEADER, SESSION_ID_HEADER, USER_ID_HEADER, isHostedAuthEnabled } from '@/lib/auth/mode';
import { createSupabaseRequestClient } from '@/lib/supabase/server';
import { hasSupabaseBrowserConfig } from '@/lib/supabase/env';
import { recordRequestStage, timeRequestStage } from '@/lib/server/request-timing';

const principalCache = new WeakMap<Request, Promise<Principal>>();

interface AccountRow {
  role: AppRole;
  status: AccountStatus;
  session_valid_after: Date | string;
}

interface ClaimsLike {
  sub?: unknown;
  email?: unknown;
  session_id?: unknown;
  iat?: unknown;
  user_metadata?: unknown;
  app_metadata?: unknown;
  role?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Postgres SQLSTATEs that mean the hosted account/session registry is not
 * installed. Dual-mode classroom Postgres has no `app_internal` schema, so
 * `app_internal.session_is_active` raises 3F000 rather than undefined_function.
 */
export function isAbsentSessionRegistryError(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return code === '42883' || code === '42P01' || code === '3F000';
}

/** Pooler timeouts and dropped connections. Never log the connection string. */
export function isTransientRegistryError(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === '57P01' ||
    code === '08006' ||
    code === '08001' ||
    code === '08004' ||
    code === '53300'
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|ECONNRESET|Connection terminated|too many clients/i.test(message);
}

async function withRegistryRetry<T>(work: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      last = error;
      if (!isTransientRegistryError(error) || attempt === 2) throw error;
      const waitMs = 200 * (attempt + 1);
      recordRequestStage('auth.retry_wait', waitMs);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw last;
}

function parseRole(value: unknown): AppRole {
  return value === 'admin' ? 'admin' : 'user';
}

function parseStatus(value: unknown): AccountStatus {
  if (value === 'disabled' || value === 'deleting') return value;
  return 'active';
}

/** Hosted app_accounts wins. JWT user_metadata / nicknames are ignored. */
export function resolveAccountAccess(input: {
  hosted?: { role?: unknown; status?: unknown };
  classroom?: { role?: unknown; status?: unknown };
}): { role: AppRole; status: AccountStatus } {
  return {
    role: parseRole(input.hosted?.role ?? input.classroom?.role),
    status: parseStatus(input.hosted?.status ?? input.classroom?.status),
  };
}

function getSharedPool(): Pool | undefined {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) return undefined;
  return getPersistencePool();
}

async function loadAccount(userId: string): Promise<AccountRow | undefined> {
  const pool = getSharedPool();
  if (!pool) return undefined;
  try {
    const result = await timeRequestStage('auth.load_account', () =>
      withRegistryRetry(() =>
        pool.query<AccountRow>(
          `SELECT role, status, session_valid_after
           FROM app_accounts
           WHERE user_id = $1`,
          [userId],
        ),
      ),
    );
    return result.rows[0];
  } catch (error) {
    if (isAbsentSessionRegistryError(error)) return undefined;
    throw new AuthError('AUTH_UNAVAILABLE', 'Account registry is unavailable');
  }
}

async function loadHostedAccountFromJwt(
  supabase: ReturnType<typeof createSupabaseRequestClient>,
  userId: string,
): Promise<{ role: AppRole; status: AccountStatus } | undefined> {
  try {
    const { data, error } = await timeRequestStage('auth.account_self', async () =>
      supabase.from('app_accounts').select('role,status').eq('user_id', userId).maybeSingle(),
    );
    if (error) throw error;
    if (!data) return undefined;
    const row = data as { role?: unknown; status?: unknown };
    return { role: parseRole(row.role), status: parseStatus(row.status) };
  } catch {
    throw new AuthError('AUTH_UNAVAILABLE', 'Hosted account status is unavailable');
  }
}

async function ensureAccountRow(
  userId: string,
  email: string,
  hosted?: { role: AppRole; status: AccountStatus },
): Promise<AccountRow | undefined> {
  const pool = getSharedPool();
  if (!pool) return undefined;
  try {
    await timeRequestStage('auth.ensure_account', () =>
      withRegistryRetry(() =>
        pool.query(`SELECT app_internal.ensure_account($1::uuid, $2, $3, $4)`, [
          userId,
          email.split('@')[0] ?? 'user',
          hosted?.role ?? null,
          hosted?.status ?? null,
        ]),
      ),
    );
    return loadAccount(userId);
  } catch (error) {
    if (isAbsentSessionRegistryError(error)) return undefined;
    throw new AuthError('AUTH_UNAVAILABLE', 'Account registry is unavailable');
  }
}

async function sessionIsActive(userId: string, sessionId: string): Promise<boolean> {
  const pool = getSharedPool();
  if (!pool) return true;
  try {
    const result = await timeRequestStage('auth.session_active', () =>
      withRegistryRetry(() =>
        pool.query<{ ok: boolean }>(
          `SELECT app_internal.session_is_active($1::uuid, $2::uuid) AS ok`,
          [userId, sessionId],
        ),
      ),
    );
    return result.rows[0]?.ok === true;
  } catch (error) {
    if (isAbsentSessionRegistryError(error)) return true;
    throw new AuthError('AUTH_UNAVAILABLE', 'Session registry is unavailable');
  }
}

function assertClientBinding(request: Request, principal: Principal): void {
  const claimedUser = request.headers.get(USER_ID_HEADER);
  const claimedSession = request.headers.get(SESSION_ID_HEADER);
  if (claimedUser && claimedUser !== principal.userId) {
    throw new AuthError('UNAUTHENTICATED', 'Request user marker does not match the session');
  }
  if (claimedSession && claimedSession !== principal.sessionId) {
    throw new AuthError('UNAUTHENTICATED', 'Request session marker does not match the session');
  }
  void request.headers.get(AUTH_EPOCH_HEADER);
}

async function resolvePrincipal(request: Request, responseHeaders?: Headers): Promise<Principal> {
  if (!hasSupabaseBrowserConfig()) {
    throw new AuthError('AUTH_UNAVAILABLE', 'Supabase is not configured');
  }
  const supabase = createSupabaseRequestClient(request, responseHeaders);
  let claims: ClaimsLike | undefined;
  try {
    const result = await timeRequestStage('auth.claims', () => supabase.auth.getClaims());
    claims = result.data?.claims as ClaimsLike | undefined;
  } catch {
    throw new AuthError('AUTH_UNAVAILABLE', 'Auth service is unavailable');
  }
  const userId = asString(claims?.sub);
  const sessionId = asString(claims?.session_id);
  const email = asString(claims?.email) ?? '';
  if (!userId || !sessionId) {
    throw new AuthError('UNAUTHENTICATED');
  }

  void claims?.user_metadata;
  void claims?.app_metadata;
  void claims?.role;
  const hosted = await loadHostedAccountFromJwt(supabase, userId);
  let account: AccountRow | undefined;
  try {
    // ensure_account / app_accounts via the unbound pool belong to the
    // dual-mode classroom registry. Hosted schema never installs
    // ensure_account (42883 made pg destroy a pooled connection on every
    // request) and app_web RLS hides app_accounts without an owner binding,
    // so hosted role/status come from the JWT self-select above. Account
    // deletion sets status='deleting' together with session_valid_after, and
    // session_is_active below still runs on every request.
    if (!isHostedAuthEnabled()) {
      account = (await ensureAccountRow(userId, email, hosted)) ?? (await loadAccount(userId));
    }
  } catch (error) {
    // Hosted JWT already carries role/status. Pooler flakes must not 503
    // list/GET after Auth succeeded.
    if (
      !(error instanceof AuthError) ||
      error.code !== 'AUTH_UNAVAILABLE' ||
      !isHostedAuthEnabled() ||
      !hosted
    ) {
      throw error;
    }
  }
  if (!hosted && !account) {
    throw new AuthError('AUTH_UNAVAILABLE', 'Account status is unavailable');
  }
  const { role, status } = resolveAccountAccess({ hosted, classroom: account });
  if (status !== 'active') {
    throw new AuthError('ACCOUNT_DISABLED', 'This account is not active');
  }
  const validAfter = account?.session_valid_after
    ? new Date(account.session_valid_after).getTime()
    : 0;
  const iat = asNumber(claims?.iat);
  if (iat && validAfter && iat * 1000 < validAfter) {
    throw new AuthError('SESSION_REVOKED', 'Session is no longer valid');
  }
  try {
    if (!(await sessionIsActive(userId, sessionId))) {
      throw new AuthError('SESSION_REVOKED', 'Session is no longer valid');
    }
  } catch (error) {
    if (error instanceof AuthError && error.code === 'SESSION_REVOKED') throw error;
    if (
      !(error instanceof AuthError) ||
      error.code !== 'AUTH_UNAVAILABLE' ||
      !isHostedAuthEnabled() ||
      !hosted
    ) {
      throw error;
    }
  }

  const principal = createPrincipal({ userId, role, sessionId, email, status });
  assertClientBinding(request, principal);
  return principal;
}

function requestHasSupabaseAuthCookie(request: Request): boolean {
  return /(?:^|;\s*)sb-[a-z0-9]+-auth-token/i.test(request.headers.get('cookie') ?? '');
}

export function requirePrincipal(request: Request, responseHeaders?: Headers): Promise<Principal> {
  const cached = principalCache.get(request);
  if (cached) return cached;
  const pending = resolvePrincipal(request, responseHeaders);
  principalCache.set(request, pending);
  return pending;
}

export async function tryPrincipal(
  request: Request,
  responseHeaders?: Headers,
): Promise<Principal | undefined> {
  if (!hasSupabaseBrowserConfig()) return undefined;
  try {
    return await requirePrincipal(request, responseHeaders);
  } catch (error) {
    if (!(error instanceof AuthError)) throw error;
    if (error.code === 'UNAUTHENTICATED') return undefined;
    // Dual-mode unsigned traffic must survive Auth outages. A present session
    // cookie still fails closed so a signed-in user cannot fall onto the
    // shared anonymous pile.
    if (
      !isHostedAuthEnabled() &&
      error.code === 'AUTH_UNAVAILABLE' &&
      !requestHasSupabaseAuthCookie(request)
    ) {
      return undefined;
    }
    throw error;
  }
}
