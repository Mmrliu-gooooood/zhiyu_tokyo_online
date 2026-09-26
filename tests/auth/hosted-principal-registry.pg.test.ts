import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ACCOUNTS_MIGRATION_1 } from '@/lib/server/accounts/sql-accounts';
import { ACCOUNTS_RLS_SQL } from '@/lib/server/accounts/sql-rls';

/**
 * Hosted principal resolution against real PostgreSQL + RLS.
 *
 * Tokyo's hosted schema has app_internal.session_is_active but no classroom
 * app_internal.ensure_account, and app_web can only read app_accounts under an
 * owner binding. The classroom-only registry calls used to fail with 42883 on
 * every request, which made node-postgres destroy the pooled connection.
 */

const baseUrl = process.env.TEST_HOSTED_CAPACITY_DATABASE_URL?.trim();
const enabled = Boolean(baseUrl);
const PROOF_DATABASE = 'auth_registry_rls_proof';

const mocks = vi.hoisted(() => ({
  pool: undefined as Pool | undefined,
  claims: vi.fn(),
  account: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseRequestClient: () => ({
    auth: { getClaims: mocks.claims },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: mocks.account }) }) }),
  }),
}));
vi.mock('@/lib/db/pool-registry', () => ({
  getPersistencePool: () => {
    if (!mocks.pool) throw new Error('proof pool not ready');
    return mocks.pool;
  },
}));

import { requirePrincipal } from '@/lib/auth/session';

function withDatabase(url: string, database: string, user?: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  if (user) {
    parsed.username = user;
    parsed.password = '';
  }
  return parsed.toString();
}

function assertDisposableDatabase(url: string): void {
  const parsed = new URL(url);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (
    parsed.hostname !== '127.0.0.1' ||
    !database.endsWith('_rls_proof') ||
    parsed.port !== '55432'
  ) {
    throw new Error(
      'TEST_HOSTED_CAPACITY_DATABASE_URL must target a disposable *_rls_proof database on port 55432',
    );
  }
}

function extract(sql: string, pattern: RegExp): string {
  const match = sql.match(pattern);
  if (!match) throw new Error(`schema fragment not found: ${pattern}`);
  return match[0];
}

// Exact production fragments: session_is_active and app_accounts DDL from
// accounts v1, and the app_web owner-bound select policy from the RLS SQL.
const SESSION_IS_ACTIVE_SQL = extract(
  ACCOUNTS_MIGRATION_1,
  /CREATE OR REPLACE FUNCTION app_internal\.session_is_active[\s\S]*?\$fn\$;/,
);
const APP_ACCOUNTS_DDL = extract(
  ACCOUNTS_MIGRATION_1,
  /CREATE TABLE IF NOT EXISTS app_accounts \([\s\S]*?\n\);/,
);
const APP_ACCOUNTS_WEB_SELECT_POLICY = extract(
  ACCOUNTS_RLS_SQL,
  /CREATE POLICY app_accounts_web_select ON app_accounts[\s\S]*?;/,
);

const BASELINE_SQL = `
DROP SCHEMA IF EXISTS public CASCADE;
DROP SCHEMA IF EXISTS app_internal CASCADE;
DROP SCHEMA IF EXISTS auth CASCADE;
CREATE SCHEMA public;
CREATE SCHEMA app_internal;
CREATE SCHEMA auth;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_web') THEN CREATE ROLE app_web NOLOGIN NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='auth_registry_proof_web') THEN
    CREATE ROLE auth_registry_proof_web LOGIN NOBYPASSRLS;
  END IF;
END
$roles$;
GRANT app_web TO auth_registry_proof_web;
GRANT USAGE ON SCHEMA public, app_internal TO app_web;

CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE TABLE auth.sessions (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth.users(id));

CREATE OR REPLACE FUNCTION app_internal.current_owner_id()
RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog
AS $fn$ SELECT nullif(current_setting('app.owner_id', true), '') $fn$;
REVOKE ALL ON FUNCTION app_internal.current_owner_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_internal.current_owner_id() TO app_web;

${SESSION_IS_ACTIVE_SQL}
REVOKE ALL ON FUNCTION app_internal.session_is_active(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_internal.session_is_active(uuid, uuid) TO app_web;

${APP_ACCOUNTS_DDL}
ALTER TABLE app_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_accounts FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON TABLE app_accounts TO app_web;
${APP_ACCOUNTS_WEB_SELECT_POLICY}
`;

const userA = '11111111-1111-4111-8111-111111111111';
const userB = '22222222-2222-4222-8222-222222222222';
const sessionA = '33333333-3333-4333-8333-333333333333';
const sessionB = '44444444-4444-4444-8444-444444444444';

describe.skipIf(!enabled)('hosted principal resolution under real PostgreSQL RLS', () => {
  let admin: Pool;
  let web: Pool;
  let connects = 0;
  let removals = 0;
  const statements: string[] = [];

  beforeAll(async () => {
    assertDisposableDatabase(baseUrl!);
    const bootstrap = new Pool({ connectionString: baseUrl, max: 1 });
    try {
      const exists = await bootstrap.query('SELECT 1 FROM pg_database WHERE datname=$1', [
        PROOF_DATABASE,
      ]);
      if (!exists.rows.length) await bootstrap.query(`CREATE DATABASE ${PROOF_DATABASE}`);
    } finally {
      await bootstrap.end();
    }
    admin = new Pool({ connectionString: withDatabase(baseUrl!, PROOF_DATABASE), max: 1 });
    await admin.query(BASELINE_SQL);
    await admin.query('INSERT INTO auth.users(id) VALUES ($1), ($2)', [userA, userB]);
    await admin.query('INSERT INTO auth.sessions(id,user_id) VALUES ($1,$2), ($3,$4)', [
      sessionA,
      userA,
      sessionB,
      userB,
    ]);
    await admin.query(
      `INSERT INTO app_accounts(user_id, owner_id, session_valid_after)
       VALUES ($1::uuid, 'user:' || $1::text, to_timestamp(0)),
              ($2::uuid, 'user:' || $2::text, to_timestamp(0))`,
      [userA, userB],
    );

    // Same shape as the hosted Web pool: app_web login role, max 5, NOBYPASSRLS.
    web = new Pool({
      connectionString: withDatabase(baseUrl!, PROOF_DATABASE, 'auth_registry_proof_web'),
      max: 5,
    });
    web.on('connect', () => {
      connects += 1;
    });
    web.on('remove', () => {
      removals += 1;
    });
    web.on('error', () => {});
    const originalQuery = web.query.bind(web) as (...args: unknown[]) => unknown;
    (web as unknown as { query: (...args: unknown[]) => unknown }).query = (...args) => {
      statements.push(String(args[0]));
      return originalQuery(...args);
    };
    mocks.pool = web;
  }, 30_000);

  afterAll(async () => {
    mocks.pool = undefined;
    await web?.end();
    await admin?.end();
  });

  beforeEach(() => {
    vi.stubEnv('DATABASE_URL', 'postgres://proof-placeholder');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'test');
    mocks.claims.mockReset();
    mocks.account.mockReset();
    mocks.claims.mockResolvedValue({
      data: { claims: { sub: userA, session_id: sessionA, email: 'a@example.test' } },
    });
    mocks.account.mockResolvedValue({ data: { role: 'user', status: 'active' }, error: null });
    statements.length = 0;
  });

  afterEach(() => vi.unstubAllEnvs());

  function hosted() {
    vi.stubEnv('AUTH_MODE', 'supabase');
    vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', 'supabase');
  }

  function resolve() {
    return requirePrincipal(new Request('http://localhost/api/persistence/runtime/sessions'));
  }

  it('baseline: the classroom registry path destroys a pooled connection on every request', async () => {
    vi.stubEnv('AUTH_MODE', '');
    vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', '');
    // Start from a warm, idle pool so only the per-request churn is counted.
    await web.query('SELECT 1');
    const before = { connects, removals };
    for (let index = 0; index < 5; index += 1) {
      const principal = await resolve();
      expect(principal.userId).toBe(userA);
    }
    expect(statements.filter((sql) => sql.includes('ensure_account'))).toHaveLength(5);
    // 42883 from ensure_account releases the client with an error: it is removed
    // and the next query must open a new connection.
    expect(removals - before.removals).toBe(5);
    expect(connects - before.connects).toBeGreaterThanOrEqual(5);
  });

  it('hosted mode reuses one connection and never calls the classroom registry', async () => {
    hosted();
    await web.query('SELECT 1');
    const before = { connects, removals };
    for (let index = 0; index < 20; index += 1) {
      const principal = await resolve();
      expect(principal).toMatchObject({ userId: userA, sessionId: sessionA, role: 'user' });
    }
    expect(removals - before.removals).toBe(0);
    expect(connects - before.connects).toBe(0);
    expect(statements.some((sql) => sql.includes('ensure_account'))).toBe(false);
    expect(statements.some((sql) => /FROM app_accounts/i.test(sql))).toBe(false);
    // Revocation is still checked on every request.
    expect(statements.filter((sql) => sql.includes('session_is_active'))).toHaveLength(20);
  });

  it('proves the skipped unbound account read could never see the row under app_web RLS', async () => {
    const unbound = await web.query('SELECT role FROM app_accounts WHERE user_id=$1', [userA]);
    expect(unbound.rows).toHaveLength(0);
    const client = await web.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.owner_id',$1,true)", [`user:${userA}`]);
      const bound = await client.query('SELECT user_id FROM app_accounts ORDER BY user_id');
      await client.query('COMMIT');
      expect(bound.rows.map((row) => row.user_id)).toEqual([userA]);
    } finally {
      client.release();
    }
  });

  it('still rejects a revoked session, a foreign session and a non-active hosted account', async () => {
    hosted();
    await admin.query('DELETE FROM auth.sessions WHERE id=$1', [sessionA]);
    try {
      await expect(resolve()).rejects.toMatchObject({ code: 'SESSION_REVOKED' });
    } finally {
      await admin.query('INSERT INTO auth.sessions(id,user_id) VALUES ($1,$2)', [sessionA, userA]);
    }

    mocks.claims.mockResolvedValue({
      data: { claims: { sub: userA, session_id: sessionB, email: 'a@example.test' } },
    });
    await expect(resolve()).rejects.toMatchObject({ code: 'SESSION_REVOKED' });

    mocks.claims.mockResolvedValue({
      data: { claims: { sub: userA, session_id: sessionA, email: 'a@example.test' } },
    });
    for (const status of ['deleting', 'disabled']) {
      mocks.account.mockResolvedValue({ data: { role: 'user', status }, error: null });
      await expect(resolve()).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' });
    }

    mocks.account.mockResolvedValue({ data: null, error: null });
    await expect(resolve()).rejects.toMatchObject({ code: 'AUTH_UNAVAILABLE' });
  });

  it('keeps the hosted admin role from the JWT self-select', async () => {
    hosted();
    mocks.account.mockResolvedValue({ data: { role: 'admin', status: 'active' }, error: null });
    await expect(resolve()).resolves.toMatchObject({ role: 'admin', userId: userA });
  });
});
