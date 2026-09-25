/**
 * Shared lookup for reserved-admin provision/remove scripts.
 * Never prints passwords or access tokens.
 */
import { Pool } from 'pg';

import { createSupabaseAdminClient } from '../../lib/supabase/admin';
import { getSupabaseSecretKey, getSupabaseUrl, getSupabasePublishableKey } from '../../lib/supabase/env';
import { HOSTED_LOGIN_PASSWORD_MIN_LENGTH } from '../../lib/auth/password-policy';
import {
  hostedAdminDatabaseUrl,
  hostedAppWebDatabaseUrl,
  hostedPgPool,
} from './hosted-operator-env';

export const MIN_TEST_ADMIN_PASSWORD_LENGTH = HOSTED_LOGIN_PASSWORD_MIN_LENGTH;

export type OwnedCounts = Record<string, number | string>;

export type SessionSummary = {
  id: string;
  createdAt?: string;
  updatedAt?: string;
};

export type AdminLookup = {
  userId: string;
  email: string;
  emailConfirmed?: boolean;
  role?: string;
  status?: string;
  ownerId: string;
  sessions?: SessionSummary[];
  owned?: OwnedCounts;
  lookup: 'auth-admin' | 'hosted-sql' | 'self-snapshot';
};

const OWNED_SQL: Array<[string, string, string]> = [
  ['document_stages', 'owner_id', 'owner'],
  ['generation_jobs', 'owner_id', 'owner'],
  ['runtime_sessions', 'learner_key', 'owner'],
  ['asset_entries', 'principal', 'owner'],
  ['classroom_snapshots', 'owner_id', 'owner'],
  ['render_job_owners', 'owner_id', 'owner'],
  ['account_kv', 'owner_id', 'owner'],
  ['usage_events', 'owner_id', 'owner'],
  ['app_accounts', 'owner_id', 'owner'],
  ['app_profiles', 'user_id', 'id'],
  ['admin_audit_events', 'actor_user_id', 'id'],
];

function hostedAuthConfig(): { url: string; key: string } {
  const url = getSupabaseUrl();
  const key = getSupabasePublishableKey();
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY are required');
  return { url: url.replace(/\/$/, ''), key };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { message: text.slice(0, 200) };
  }
}

async function countOwned(pool: Pool, ownerId: string, userId: string): Promise<OwnedCounts> {
  const owned: OwnedCounts = {};
  for (const [table, column, bind] of OWNED_SQL) {
    const value = bind === 'id' ? userId : ownerId;
    try {
      const result = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table} WHERE ${column} = $1`,
        [value],
      );
      owned[table] = Number(result.rows[0]?.count ?? 0);
    } catch {
      owned[table] = 'unavailable';
    }
  }
  return owned;
}

async function listSessionsSql(pool: Pool, userId: string): Promise<SessionSummary[]> {
  const result = await pool.query<{ id: string; created_at: Date; updated_at: Date }>(
    `SELECT id::text, created_at, updated_at FROM auth.sessions WHERE user_id = $1::uuid ORDER BY created_at`,
    [userId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at?.toISOString?.() ?? String(row.created_at),
    updatedAt: row.updated_at?.toISOString?.() ?? String(row.updated_at),
  }));
}

async function lookupViaAuthAdmin(email: string): Promise<AdminLookup | null> {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw error;
  const user = data.users.find((entry) => entry.email?.toLowerCase() === email.toLowerCase());
  if (!user) return null;
  const ownerId = `user:${user.id}`;
  let sessions: SessionSummary[] = [];
  const db = hostedAdminDatabaseUrl() ?? hostedAppWebDatabaseUrl();
  let owned: OwnedCounts | undefined;
  let role: string | undefined;
  let status: string | undefined;
  if (db) {
    const pool = hostedPgPool(db);
    try {
      if (sessions.length === 0) sessions = await listSessionsSql(pool, user.id).catch(() => sessions);
      owned = await countOwned(pool, ownerId, user.id);
      const account = await pool.query<{ role: string; status: string }>(
        'SELECT role, status FROM app_accounts WHERE user_id = $1',
        [user.id],
      );
      role = account.rows[0]?.role;
      status = account.rows[0]?.status;
    } finally {
      await pool.end();
    }
  }
  return {
    userId: user.id,
    email,
    emailConfirmed: Boolean(user.email_confirmed_at),
    role,
    status,
    ownerId,
    sessions,
    owned,
    lookup: 'auth-admin',
  };
}

async function lookupViaHostedSql(email: string): Promise<AdminLookup | null> {
  const db = hostedAdminDatabaseUrl();
  if (!db) return null;
  const pool = hostedPgPool(db);
  try {
    const found = await pool.query<{ id: string; email_confirmed: boolean }>(
      `SELECT id::text, email_confirmed_at IS NOT NULL AS email_confirmed
       FROM auth.users WHERE lower(email) = lower($1)`,
      [email],
    );
    const row = found.rows[0];
    if (!row) return null;
    const ownerId = `user:${row.id}`;
    const account = await pool.query<{ role: string; status: string }>(
      'SELECT role, status FROM app_accounts WHERE user_id = $1',
      [row.id],
    );
    return {
      userId: row.id,
      email,
      emailConfirmed: row.email_confirmed,
      role: account.rows[0]?.role,
      status: account.rows[0]?.status,
      ownerId,
      sessions: await listSessionsSql(pool, row.id).catch(() => []),
      owned: await countOwned(pool, ownerId, row.id),
      lookup: 'hosted-sql',
    };
  } finally {
    await pool.end();
  }
}

async function lookupViaSelfSnapshot(email: string, password: string): Promise<AdminLookup | null> {
  const { url, key } = hostedAuthConfig();
  const login = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  });
  const loginBody = await readJson(login);
  const user = loginBody.user as { id?: string; email?: string; email_confirmed_at?: string } | undefined;
  const accessToken = typeof loginBody.access_token === 'string' ? loginBody.access_token : '';
  if (!login.ok || !user?.id || !accessToken) {
    const message = String(loginBody.error_description || loginBody.msg || loginBody.error || login.statusText);
    if (/invalid.*(login|credentials)|email not confirmed/i.test(message)) return null;
    throw new Error(message);
  }
  try {
    const snapshot = await fetch(`${url}/rest/v1/rpc/reserved_admin_lifecycle_snapshot`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_email: email }),
    });
    const body = await readJson(snapshot);
    if (!snapshot.ok) {
      throw new Error(String(body.message || body.hint || body.error || snapshot.statusText));
    }
    const data = (body as { userId?: string }).userId ? body : ((body as { data?: Record<string, unknown> }).data ?? body);
    return {
      userId: String(data.userId ?? user.id),
      email,
      emailConfirmed: Boolean(data.emailConfirmed ?? user.email_confirmed_at),
      role: typeof data.role === 'string' ? data.role : undefined,
      status: typeof data.status === 'string' ? data.status : undefined,
      ownerId: String(data.ownerId ?? `user:${user.id}`),
      sessions: Array.isArray(data.sessions) ? (data.sessions as SessionSummary[]) : [],
      owned: (data.owned as OwnedCounts | undefined) ?? {},
      lookup: 'self-snapshot',
    };
  } finally {
    await fetch(`${url}/auth/v1/logout`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${accessToken}`,
      },
    }).catch(() => undefined);
  }
}

export async function lookupReservedAdmin(email: string): Promise<AdminLookup | null> {
  if (getSupabaseSecretKey()) {
    return lookupViaAuthAdmin(email);
  }
  const fromSql = await lookupViaHostedSql(email);
  if (fromSql) return fromSql;
  const password = process.env.TEST_ADMIN_PASSWORD ?? '';
  if (password) {
    return lookupViaSelfSnapshot(email, password);
  }
  return null;
}
