/**
 * Fresh-database bootstrap for the hosted accounts schema: disposable test
 * stacks and new staging databases only. Never production.
 *
 * `migrateAccountsSchema` cannot build a fresh hosted database. It applies v1
 * when the base tables already exist, so v1 creates owner policies on
 * document_stages / generation_jobs that v8 later re-creates without
 * `DROP POLICY IF EXISTS` (42710 at v8). Production never hit this: v1–v4 ran
 * before those tables existed and v5–v7 are classroom-only. The migration SQL
 * is frozen by the checksums in production `app_schema_migrations`, so this
 * bootstrap replays production's order instead:
 *
 *   v1–v4 → base schemas (as `generation:migrate`) → FORCE RLS flags → v8+
 *
 * Versions 5–7 are left unapplied, as in production. When the base tables
 * existed before v1, the policies v1 attached to them and v8 re-creates
 * unguarded are dropped right before v8, so both starting points end in the
 * same schema. Everything runs in one transaction and only on an empty
 * database: no accounts version recorded and no account, course or job rows.
 * Operator guide: docs/guides/zhiyu-fresh-accounts-database.md.
 */
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { Queryable } from '@openmaic/storage/document/pg';
import { ensureAssetSchema } from '@openmaic/storage/asset/pg';
import { ensureAgentSessionSchema } from '@openmaic/storage/agent-session/pg';
import { ensureDocumentSchema } from '@openmaic/storage/document/pg';
import { ensureAgentSessionMaterialSchema } from '@openmaic/storage/material/pg';
import { ensureSchema } from '@openmaic/storage/runtime/pg';
import { ensureUserSkillSchema } from '@openmaic/storage/skill/pg';

import { ensureOwnerMaterialSchema } from '@/lib/persistence/owner-materials';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import { migrateGenerationSchema } from '../generation-jobs/migrations';
import { ACCOUNT_MIGRATIONS, applyStatements } from './migrations';
import { ACCOUNTS_SCHEMA_VERSION } from './sql-accounts';

/** Applied before the base schemas, as on production. */
export const PRE_BASE_ACCOUNTS_VERSIONS = [1, 2, 3, 4] as const;
/** Classroom-only versions production never recorded. */
export const CLASSROOM_ONLY_ACCOUNTS_VERSIONS = [5, 6, 7] as const;

/** Tables `migrateAccountsSchema` requires to FORCE row security before v8+. */
export const FORCE_RLS_BASE_TABLES = ['document_stages', 'stage_meta', 'generation_jobs'] as const;

/**
 * Policies v1 creates when their table exists and v8 re-creates without
 * `DROP POLICY IF EXISTS`. v8 creates each again with the same definition.
 */
export const V1_POLICIES_RECREATED_BY_V8 = [
  ['document_stages', 'document_stages_web_insert'],
  ['document_stages', 'document_stages_web_update'],
  ['document_stages', 'document_stages_web_delete'],
  ['generation_jobs', 'generation_jobs_web_insert'],
  ['generation_jobs', 'generation_jobs_web_update'],
] as const;

/** Tables that must be empty (when present) for the database to count as fresh. */
const FRESH_EMPTY_TABLES = [
  'app_accounts',
  'document_stages',
  'stage_meta',
  'generation_jobs',
  'agent_sessions',
] as const;

/**
 * Minimal Supabase Auth surface the accounts SQL references (roles anon and
 * authenticated, auth.users, auth.sessions, auth.uid()) for plain PostgreSQL.
 * Creates only what is missing, so it never replaces Supabase's own objects.
 */
export const SUPABASE_AUTH_STUB_SQL = `
DO $supabase_auth_stub$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  CREATE SCHEMA IF NOT EXISTS auth;
  CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb);
  CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY, user_id uuid);
  IF to_regprocedure('auth.uid()') IS NULL THEN
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
      AS 'SELECT nullif(current_setting(''request.jwt.claim.sub'', true), '''')::uuid';
  END IF;
END
$supabase_auth_stub$;
`;

export interface FreshBootstrapClient extends Queryable {
  release(): void;
}

export interface FreshBootstrapSource {
  connect(): Promise<FreshBootstrapClient>;
}

export interface FreshBootstrapOptions {
  /** Plain PostgreSQL without Supabase Auth: apply {@link SUPABASE_AUTH_STUB_SQL} first. */
  stubSupabaseAuth?: boolean;
}

export interface FreshBootstrapResult {
  /** Accounts versions recorded in app_schema_migrations, ascending. */
  versions: number[];
  /** True when the base tables existed before v1 (v1 policies were replaced). */
  baseSchemasPreexisted: boolean;
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

async function tableExists(client: Queryable, table: string): Promise<boolean> {
  const result = await client.query<{ name: string | null }>(
    'SELECT to_regclass($1)::text AS name',
    [`public.${table}`],
  );
  return Boolean(result.rows[0]?.name);
}

async function assertFreshDatabase(client: Queryable): Promise<void> {
  const database = await client.query<{ name: string }>('SELECT current_database() AS name');
  if (database.rows[0]?.name === 'openmaic') {
    throw new Error('Refusing fresh accounts bootstrap on classroom database openmaic');
  }
  const recorded = await client.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM app_schema_migrations',
  );
  if (recorded.rows[0]?.count !== '0') {
    throw new Error(
      'Refusing fresh accounts bootstrap: app_schema_migrations already records accounts versions',
    );
  }
  for (const table of FRESH_EMPTY_TABLES) {
    if (!(await tableExists(client, table))) continue;
    const rows = await client.query(`SELECT 1 FROM public.${table} LIMIT 1`);
    if (rows.rows.length) {
      throw new Error(`Refusing fresh accounts bootstrap: ${table} already has rows`);
    }
  }
}

/** `migrateGenerationSchema` opens its own transaction; nest it in a savepoint. */
function savepointSource(client: Queryable) {
  return {
    connect: async () => ({
      query: (text: string, params?: unknown[]) => {
        if (text === 'BEGIN') return client.query('SAVEPOINT fresh_bootstrap_generation');
        if (text === 'COMMIT') return client.query('RELEASE SAVEPOINT fresh_bootstrap_generation');
        if (text === 'ROLLBACK') {
          return client.query('ROLLBACK TO SAVEPOINT fresh_bootstrap_generation');
        }
        return client.query(text, params);
      },
      release: () => undefined,
    }),
  };
}

/** The base schemas in `workers/generation/migrate.ts` order. */
async function ensureBaseSchemas(client: Queryable): Promise<void> {
  await ensureSchema(client);
  await ensureDocumentSchema(client);
  await ensureStageMetaSchema(client);
  await ensureOwnerMaterialSchema(client);
  await ensureAssetSchema(client);
  await ensureAgentSessionSchema(client);
  await ensureAgentSessionMaterialSchema(client);
  await ensureUserSkillSchema(client);
  await migrateGenerationSchema(savepointSource(client));
}

async function applyVersion(
  client: Queryable,
  migration: (typeof ACCOUNT_MIGRATIONS)[number],
): Promise<void> {
  await applyStatements(client, migration.sql);
  await client.query('INSERT INTO app_schema_migrations(version,checksum) VALUES($1,$2)', [
    migration.version,
    checksum(migration.sql),
  ]);
}

/**
 * Operator entry for fresh disposable or staging databases; see the module
 * comment. Later accounts versions on the result are applied the way
 * production applies them, never with `migrateAccountsSchema` (it would add
 * v5–v7).
 */
export async function bootstrapFreshAccountsDatabase(
  pool: Pool | FreshBootstrapSource,
  options: FreshBootstrapOptions = {},
): Promise<FreshBootstrapResult> {
  const client = (await pool.connect()) as FreshBootstrapClient;
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('openmaic:accounts:migrations'))");
    await client.query(
      'CREATE TABLE IF NOT EXISTS app_schema_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())',
    );
    await assertFreshDatabase(client);
    if (options.stubSupabaseAuth) await applyStatements(client, SUPABASE_AUTH_STUB_SQL);

    const baseSchemasPreexisted = await tableExists(client, 'document_stages');
    const classroomOnly = new Set<number>(CLASSROOM_ONLY_ACCOUNTS_VERSIONS);
    const preBase = new Set<number>(PRE_BASE_ACCOUNTS_VERSIONS);
    const pending = ACCOUNT_MIGRATIONS.filter((item) => !classroomOnly.has(item.version));
    for (const migration of pending.filter((item) => preBase.has(item.version))) {
      await applyVersion(client, migration);
    }

    await ensureBaseSchemas(client);
    for (const table of FORCE_RLS_BASE_TABLES) {
      await client.query(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`);
    }
    for (const [table, policy] of V1_POLICIES_RECREATED_BY_V8) {
      await client.query(`DROP POLICY IF EXISTS ${policy} ON public.${table}`);
    }

    for (const migration of pending.filter((item) => !preBase.has(item.version))) {
      await applyVersion(client, migration);
    }

    const recorded = await client.query<{ version: number }>(
      'SELECT version FROM app_schema_migrations ORDER BY version',
    );
    const versions = recorded.rows.map((row) => Number(row.version));
    if (versions.at(-1) !== ACCOUNTS_SCHEMA_VERSION) {
      throw new Error(`Fresh accounts bootstrap stopped before version ${ACCOUNTS_SCHEMA_VERSION}`);
    }
    await client.query('COMMIT');
    return { versions, baseSchemasPreexisted };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
