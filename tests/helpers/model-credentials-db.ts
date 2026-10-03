/**
 * Test databases for the credential vault (accounts v21). PGlite always;
 * real PostgreSQL when TEST_MODEL_CREDENTIALS_DATABASE_URL names a dedicated
 * disposable *_rls_proof database on 127.0.0.1:55432
 * (docker-compose.accounts-rls-proof.yml). The v21 tables in that database are
 * dropped and recreated.
 */
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { ACCOUNTS_MIGRATION_21 } from '@/lib/server/accounts/sql-model-credentials';
import type { VaultDatabase } from '@/lib/model-gateway/credentials/vault';

export interface TestDb {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  close(): Promise<void>;
}

/** What v1–v20 leave behind that v21 relies on: roles and the owner GUC. */
export const V21_BASELINE = `
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_web') THEN CREATE ROLE app_web NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_worker') THEN CREATE ROLE app_worker NOLOGIN; END IF;
END
$roles$;
CREATE SCHEMA IF NOT EXISTS app_internal;
GRANT USAGE ON SCHEMA public, app_internal TO app_web, app_worker;
CREATE OR REPLACE FUNCTION app_internal.current_owner_id()
RETURNS text LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.owner_id', true), '') $$;
GRANT EXECUTE ON FUNCTION app_internal.current_owner_id() TO app_web, app_worker;
DROP TABLE IF EXISTS public.model_auth_sessions, public.model_credentials, public.model_auth_settings CASCADE;
`;

const DROP_V21 =
  'DROP TABLE IF EXISTS public.model_auth_sessions, public.model_credentials, public.model_auth_settings CASCADE';

/** Split on statement ends, keeping $tag$ … $tag$ bodies whole. */
export function sqlStatements(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let tag: string | null = null;
  for (const line of sql.split('\n')) {
    current += `${line}\n`;
    for (const match of line.matchAll(/\$[a-z_]*\$/g)) tag = tag === match[0] ? null : match[0];
    if (!tag && line.trimEnd().endsWith(';')) {
      out.push(current.trim());
      current = '';
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

export async function applySql(db: Pick<TestDb, 'query'>, sql: string): Promise<void> {
  for (const statement of sqlStatements(sql)) await db.query(statement);
}

export async function prepareV21(db: Pick<TestDb, 'query'>): Promise<void> {
  await applySql(db, V21_BASELINE);
  await applySql(db, ACCOUNTS_MIGRATION_21);
}

export function openPglite(): TestDb & { raw: PGlite } {
  const raw = new PGlite();
  return {
    raw,
    query: (sql, values) => raw.query(sql, values ?? []),
    close: () => raw.close(),
  };
}

export const postgresUrl = process.env.TEST_MODEL_CREDENTIALS_DATABASE_URL?.trim();

export function assertDisposablePostgres(url: string): void {
  const parsed = new URL(url);
  if (
    parsed.hostname !== '127.0.0.1' ||
    parsed.port !== '55432' ||
    !parsed.pathname.replace(/^\//, '').endsWith('_rls_proof')
  ) {
    throw new Error(
      'TEST_MODEL_CREDENTIALS_DATABASE_URL must be a disposable *_rls_proof database',
    );
  }
}

/** A pool on the disposable database; `close` drops the v21 tables. */
export function openPostgres(max = 1): TestDb & { pool: Pool } {
  assertDisposablePostgres(postgresUrl!);
  const pool = new Pool({ connectionString: postgresUrl, max });
  return {
    pool,
    query: (sql, values) => pool.query(sql, values),
    close: async () => {
      await pool.query(DROP_V21);
      await pool.end();
    },
  };
}

type Role = 'app_web' | 'app_worker';

/**
 * Owner-bound transactions as production runs them: switch to the app role,
 * set app.owner_id, run, commit (roll back on error). PGlite has a single
 * connection, so its transactions are serialized here.
 */
export function pgliteVault(db: PGlite, ownerId: string, role: Role = 'app_web'): VaultDatabase {
  return {
    withTransaction: (body) =>
      db.transaction(async (tx) => {
        await tx.query(`SET LOCAL ROLE ${role}`);
        await tx.query("SELECT set_config('app.owner_id',$1,true)", [ownerId]);
        return body({
          query: async (text, params) => {
            const result = await tx.query(text, params ?? []);
            return { rows: result.rows as never[] };
          },
        });
      }),
  };
}

export function postgresVault(pool: Pool, ownerId: string, role: Role = 'app_web'): VaultDatabase {
  return {
    async withTransaction(body) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL ROLE ${role}`);
        await client.query("SELECT set_config('app.owner_id',$1,true)", [ownerId]);
        const value = await body({
          query: async (text, params) => {
            const result = await client.query(text, params);
            return { rows: result.rows as never[] };
          },
        });
        await client.query('COMMIT');
        return value;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
