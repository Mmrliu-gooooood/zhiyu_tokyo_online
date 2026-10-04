/**
 * Fresh-database accounts bootstrap (lib/server/accounts/fresh-bootstrap.ts).
 * Builds a fresh database end to end through the latest accounts version, from
 * both starting points (base schemas present or absent), and proves why plain
 * `migrateAccountsSchema` cannot. Runs on PGlite always; set
 * TEST_ACCOUNTS_BOOTSTRAP_DATABASE_URL to the admin URL of a disposable
 * *_rls_proof database on 127.0.0.1:55432 (docker-compose.accounts-rls-proof.yml)
 * to repeat it on real PostgreSQL. Each case creates and drops its own
 * fresh_bootstrap_*_rls_proof database there.
 */
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { ensureAssetSchema } from '@openmaic/storage/asset/pg';
import { ensureAgentSessionSchema } from '@openmaic/storage/agent-session/pg';
import { ensureDocumentSchema, type Queryable } from '@openmaic/storage/document/pg';
import { ensureAgentSessionMaterialSchema } from '@openmaic/storage/material/pg';
import { ensureSchema } from '@openmaic/storage/runtime/pg';
import { ensureUserSkillSchema } from '@openmaic/storage/skill/pg';

import { ensureOwnerMaterialSchema } from '@/lib/persistence/owner-materials';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import { ensureStudySchema } from '@/lib/server/study/schema';
import {
  bootstrapFreshAccountsDatabase,
  FORCE_RLS_BASE_TABLES,
  SUPABASE_AUTH_STUB_SQL,
  V1_POLICIES_RECREATED_BY_V8,
  type FreshBootstrapSource,
} from '@/lib/server/accounts/fresh-bootstrap';
import {
  ACCOUNT_MIGRATIONS,
  accountsMigrationChecksum,
  applyStatements,
  migrateAccountsSchema,
} from '@/lib/server/accounts/migrations';
import { ACCOUNTS_SCHEMA_VERSION } from '@/lib/server/accounts/sql-accounts';
import {
  ACCOUNTS_RLS_SQL,
  ACCOUNTS_RLS_SQL_V2,
  ACCOUNTS_RLS_SQL_V3,
  ACCOUNTS_RLS_SQL_V4,
  ACCOUNTS_RLS_SQL_V8,
} from '@/lib/server/accounts/sql-rls';
import { migrateGenerationSchema } from '@/lib/server/generation-jobs/migrations';

interface Db extends Queryable {
  source: FreshBootstrapSource;
  close(): Promise<void>;
}

function openPglite(): Db {
  const raw = new PGlite();
  const query = ((sql: string, values?: unknown[]) =>
    raw.query(sql, values ?? [])) as Queryable['query'];
  return {
    source: { connect: async () => ({ query, release: () => undefined }) },
    query,
    close: () => raw.close(),
  };
}

const postgresAdminUrl = process.env.TEST_ACCOUNTS_BOOTSTRAP_DATABASE_URL?.trim();

function assertDisposablePostgres(url: string): void {
  const parsed = new URL(url);
  if (
    parsed.hostname !== '127.0.0.1' ||
    parsed.port !== '55432' ||
    !parsed.pathname.replace(/^\//, '').endsWith('_rls_proof')
  ) {
    throw new Error(
      'TEST_ACCOUNTS_BOOTSTRAP_DATABASE_URL must be a disposable *_rls_proof database',
    );
  }
}

/** A brand-new database on the disposable server, dropped on close. */
async function openPostgres(): Promise<Db> {
  assertDisposablePostgres(postgresAdminUrl!);
  const name = `fresh_bootstrap_${randomBytes(6).toString('hex')}_rls_proof`;
  const admin = new Pool({ connectionString: postgresAdminUrl, max: 1 });
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(postgresAdminUrl!);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.toString(), max: 1 });
  return {
    source: pool as never,
    query: ((sql: string, values?: unknown[]) => pool.query(sql, values)) as Queryable['query'],
    close: async () => {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

/** What `generation:migrate` (workers/generation/migrate.ts) leaves on a fresh database. */
async function createBaseSchemas(db: Db): Promise<void> {
  await ensureSchema(db);
  await ensureDocumentSchema(db);
  await ensureStageMetaSchema(db);
  await ensureOwnerMaterialSchema(db);
  await ensureAssetSchema(db);
  await ensureStudySchema(db);
  await ensureAgentSessionSchema(db);
  await ensureAgentSessionMaterialSchema(db);
  await ensureUserSkillSchema(db);
  await migrateGenerationSchema(db.source as never);
}

/** Policies, row-security flags and columns of every application table. */
async function schemaSnapshot(db: Db) {
  const policies = await db.query(
    `SELECT schemaname, tablename, policyname, cmd, roles::text AS roles,
            coalesce(qual, '') AS qual, coalesce(with_check, '') AS with_check
       FROM pg_policies
      WHERE schemaname IN ('public', 'app_internal')
      ORDER BY schemaname, tablename, policyname`,
  );
  const tables = await db.query(
    `SELECT n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'app_internal') AND c.relkind IN ('r', 'p')
      ORDER BY n.nspname, c.relname`,
  );
  const columns = await db.query(
    `SELECT table_schema, table_name, column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema IN ('public', 'app_internal')
      ORDER BY table_schema, table_name, column_name`,
  );
  return { policies: policies.rows, tables: tables.rows, columns: columns.rows };
}

const OWNER_A = 'user:aaaaaaaa-0000-4000-8000-00000000000a';
const OWNER_B = 'user:bbbbbbbb-0000-4000-8000-00000000000b';

const policyNames = (sql: string, verb: 'CREATE POLICY' | 'DROP POLICY IF EXISTS') =>
  new Set([...sql.matchAll(new RegExp(`${verb} (\\w+)`, 'g'))].map((match) => match[1]!));

describe('fresh accounts bootstrap: v8 conflict set', () => {
  it('drops exactly the v1–v4 policies that v8 re-creates without a guard', () => {
    const beforeBase = [
      ACCOUNTS_RLS_SQL,
      ACCOUNTS_RLS_SQL_V2,
      ACCOUNTS_RLS_SQL_V3,
      ACCOUNTS_RLS_SQL_V4,
    ]
      .map((sql) => policyNames(sql, 'CREATE POLICY'))
      .reduce((all, names) => new Set([...all, ...names]));
    const v8Guarded = policyNames(ACCOUNTS_RLS_SQL_V8, 'DROP POLICY IF EXISTS');
    const conflicts = [...policyNames(ACCOUNTS_RLS_SQL_V8, 'CREATE POLICY')]
      .filter((name) => !v8Guarded.has(name) && beforeBase.has(name))
      .sort();
    expect(V1_POLICIES_RECREATED_BY_V8.map(([, policy]) => policy).sort()).toEqual(conflicts);
  });
});

const engines: Array<[string, () => Promise<Db>]> = [['PGlite', async () => openPglite()]];
if (postgresAdminUrl) engines.push(['PostgreSQL', openPostgres]);

describe.each(engines)('fresh accounts bootstrap (%s)', (_name, open) => {
  it('migrateAccountsSchema alone fails at v8 once the base schemas exist', async () => {
    const db = await open();
    try {
      await applyStatements(db, SUPABASE_AUTH_STUB_SQL);
      await createBaseSchemas(db);
      for (const table of FORCE_RLS_BASE_TABLES) {
        await db.query(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`);
      }
      await expect(migrateAccountsSchema(db.source as never)).rejects.toMatchObject({
        code: '42710',
        message: expect.stringContaining('document_stages_web_insert'),
      });
      // Rolled back as a whole: not even the ledger table remains.
      const ledger = await db.query("SELECT to_regclass('public.app_schema_migrations') AS name");
      expect(ledger.rows).toEqual([{ name: null }]);
    } finally {
      await db.close();
    }
  }, 180_000);

  it('bootstraps through the latest version from either starting point, identically', async () => {
    const withBase = await open();
    const empty = await open();
    try {
      await applyStatements(withBase, SUPABASE_AUTH_STUB_SQL);
      await createBaseSchemas(withBase);
      const fromBase = await bootstrapFreshAccountsDatabase(withBase.source);
      const fromEmpty = await bootstrapFreshAccountsDatabase(empty.source, {
        stubSupabaseAuth: true,
      });

      const expected = ACCOUNT_MIGRATIONS.map((item) => item.version as number).filter(
        (version) => version < 5 || version > 7,
      );
      expect(fromBase).toEqual({ versions: expected, baseSchemasPreexisted: true });
      expect(fromEmpty).toEqual({ versions: expected, baseSchemasPreexisted: false });
      expect(expected.at(-1)).toBe(ACCOUNTS_SCHEMA_VERSION);

      for (const db of [withBase, empty]) {
        const rows = await db.query(
          'SELECT version, checksum FROM app_schema_migrations ORDER BY version',
        );
        expect(rows.rows).toEqual(
          expected.map((version) => ({ version, checksum: accountsMigrationChecksum(version) })),
        );
        const flags = await db.query(
          `SELECT relname FROM pg_class
            WHERE relname = ANY($1::text[]) AND relrowsecurity AND relforcerowsecurity`,
          [[...FORCE_RLS_BASE_TABLES]],
        );
        expect(flags.rows).toHaveLength(FORCE_RLS_BASE_TABLES.length);
      }
      expect(await schemaSnapshot(withBase)).toEqual(await schemaSnapshot(empty));
    } finally {
      await withBase.close();
      await empty.close();
    }
  }, 300_000);

  it('isolates owners and refuses to run on a non-fresh database', async () => {
    const db = await open();
    try {
      await bootstrapFreshAccountsDatabase(db.source, { stubSupabaseAuth: true });
      await db.query(
        `INSERT INTO document_stages(id, name, owner_id, created_at, updated_at, data)
         VALUES ('stage-a', 'A', $1, 0, 0, '{}'), ('stage-b', 'B', $2, 0, 0, '{}')`,
        [OWNER_A, OWNER_B],
      );
      await db.query('BEGIN');
      try {
        await db.query('SET LOCAL ROLE app_web');
        await db.query("SELECT set_config('app.owner_id', $1, true)", [OWNER_A]);
        const visible = await db.query('SELECT id FROM document_stages ORDER BY id');
        expect(visible.rows).toEqual([{ id: 'stage-a' }]);
      } finally {
        await db.query('ROLLBACK');
      }

      await expect(bootstrapFreshAccountsDatabase(db.source)).rejects.toThrow(
        /already records accounts versions/,
      );
      await db.query('DELETE FROM app_schema_migrations');
      await expect(bootstrapFreshAccountsDatabase(db.source)).rejects.toThrow(
        /document_stages already has rows/,
      );
    } finally {
      await db.close();
    }
  }, 180_000);
});
