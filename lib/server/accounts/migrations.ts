import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AGENT_SESSION_PG_SCHEMA } from '../../../packages/@openmaic/storage/src/agent-session/pg';
import { AGENT_SESSION_MATERIAL_PG_SCHEMA } from '../../../packages/@openmaic/storage/src/material/pg';
import { USER_SKILL_PG_SCHEMA } from '../../../packages/@openmaic/storage/src/skill/pg';

import {
  GENERATION_MIGRATION_1,
  GENERATION_MIGRATION_2,
  GENERATION_MIGRATION_3,
  GENERATION_MIGRATION_4,
  GENERATION_MIGRATIONS,
} from '../generation-jobs/migrations';
import {
  ACCOUNTS_MIGRATION_1,
  ACCOUNTS_MIGRATION_5,
  ACCOUNTS_MIGRATION_6,
  ACCOUNTS_MIGRATION_7,
  ACCOUNTS_MIGRATION_8,
  ACCOUNTS_MIGRATION_9,
  ACCOUNTS_MIGRATION_11,
  ACCOUNTS_SCHEMA_VERSION,
  CLASSROOM_SESSION_REGISTRY_ROLE_SYNC_VERSION,
  CLASSROOM_SESSION_REGISTRY_VERSION,
} from './sql-accounts';
import {
  ACCOUNTS_RLS_SQL,
  ACCOUNTS_RLS_SQL_V2,
  ACCOUNTS_RLS_SQL_V3,
  ACCOUNTS_RLS_SQL_V4,
  ACCOUNTS_RLS_SQL_V8,
  ACCOUNTS_RLS_SQL_V9,
  ACCOUNTS_RLS_SQL_V10,
  ACCOUNTS_RLS_SQL_V11,
  ACCOUNTS_RLS_SQL_V12,
  ACCOUNTS_RLS_SQL_V13,
  ACCOUNTS_RLS_SQL_V14,
  ACCOUNTS_RLS_SQL_V15,
  ACCOUNTS_RLS_SQL_V16,
  ACCOUNTS_RLS_SQL_V17,
  ACCOUNTS_RLS_SQL_V18,
} from './sql-rls';
import { PRO_MODEL_CONNECTION_SCHEMA } from '../agent-runtime/model-connection-schema';
import { ACCOUNTS_RLS_SQL_V19 } from './sql-provider-quota';
import { ACCOUNTS_MIGRATION_20 } from './sql-usage-funding';
import { ACCOUNTS_MIGRATION_21 } from './sql-model-credentials';
import { ACCOUNTS_MIGRATION_22 } from './sql-study-spaces';
import { ACCOUNTS_MIGRATION_23 } from './sql-study-materials';
import { ACCOUNTS_MIGRATION_24 } from './sql-study-knowledge';
import { ACCOUNTS_MIGRATION_25 } from './sql-study-classmates';
import { ACCOUNTS_MIGRATION_26 } from './sql-study-companion';
import { ACCOUNTS_MIGRATION_27 } from './sql-study-memory';
import { ACCOUNTS_MIGRATION_28 } from './sql-study-exams';
import { ACCOUNTS_MIGRATION_29 } from './sql-study-extraction';
import { ACCOUNTS_MIGRATION_30 } from './sql-study-grading';
import { ACCOUNTS_MIGRATION_31 } from './sql-study-wrongbook';
import { ACCOUNTS_MIGRATION_32 } from './sql-study-practice';

function executeWhenColumnMissing(table: string, column: string, sql: string): string {
  const statements = sql
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean);
  const executes = statements
    .map((statement, index) => {
      const tag = `$m9${table.replace(/_/g, '')}${index}$`;
      return `  EXECUTE ${tag}${statement}${tag};`;
    })
    .join('\n');
  return `
DO $m9_real_${table}$
BEGIN
  IF current_database() = 'openmaic' THEN
    RAISE EXCEPTION 'refusing hosted generation real-shape apply on classroom database openmaic';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = '${table}' AND column_name = '${column}'
  ) THEN
    RETURN;
  END IF;
${executes}
END
$m9_real_${table}$;
`;
}

function stampGenerationSchemaSql(): string {
  const values = GENERATION_MIGRATIONS.map((migration) => {
    const checksum = createHash('sha256').update(migration.sql).digest('hex');
    return `(${migration.version}, '${checksum}')`;
  }).join(',\n    ');
  const checks = GENERATION_MIGRATIONS.map((migration) => {
    const checksum = createHash('sha256').update(migration.sql).digest('hex');
    return `
  SELECT checksum INTO actual FROM public.generation_schema_migrations WHERE version = ${migration.version};
  IF actual IS DISTINCT FROM '${checksum}' THEN
    RAISE EXCEPTION 'hosted generation_schema_migrations checksum mismatch (version ${migration.version})';
  END IF;`;
  }).join('\n');
  return `
INSERT INTO public.generation_schema_migrations(version, checksum)
VALUES
    ${values}
ON CONFLICT (version) DO UPDATE
SET checksum = EXCLUDED.checksum
WHERE public.generation_schema_migrations.checksum IN ('', EXCLUDED.checksum);

DO $gen_schema_checksum$
DECLARE
  actual text;
BEGIN
  IF current_database() = 'openmaic' THEN
    RAISE EXCEPTION 'refusing hosted generation real-shape apply on classroom database openmaic';
  END IF;
${checks}
END
$gen_schema_checksum$;
`;
}

export function buildAccountsMigration9Sql(): string {
  return [
    ACCOUNTS_MIGRATION_9,
    executeWhenColumnMissing('generation_jobs', 'idempotency_key', GENERATION_MIGRATION_1),
    executeWhenColumnMissing('media_config_snapshots', 'ciphertext', GENERATION_MIGRATION_2),
    executeWhenColumnMissing('generation_model_snapshots', 'ciphertext', GENERATION_MIGRATION_3),
    executeWhenColumnMissing('generation_search_snapshots', 'ciphertext', GENERATION_MIGRATION_4),
    stampGenerationSchemaSql(),
    ACCOUNTS_RLS_SQL_V9,
  ].join('\n');
}

/** Hosted-only Agent/Pro schema. Existing classroom data is not referenced. */
export function buildAccountsMigration10Sql(): string {
  return [
    `DO $agent_pro_schema_guard$
BEGIN
  IF current_database() = 'openmaic' THEN
    RAISE EXCEPTION 'refusing hosted Agent/Pro schema apply on classroom database openmaic';
  END IF;
END
$agent_pro_schema_guard$;`,
    AGENT_SESSION_PG_SCHEMA,
    USER_SKILL_PG_SCHEMA,
    AGENT_SESSION_MATERIAL_PG_SCHEMA,
    PRO_MODEL_CONNECTION_SCHEMA,
    ACCOUNTS_RLS_SQL_V10,
  ].join('\n');
}

export const ACCOUNT_MIGRATIONS = [
  { version: 1, sql: `${ACCOUNTS_MIGRATION_1}\n${ACCOUNTS_RLS_SQL}` },
  { version: 2, sql: ACCOUNTS_RLS_SQL_V2 },
  { version: 3, sql: ACCOUNTS_RLS_SQL_V3 },
  { version: 4, sql: ACCOUNTS_RLS_SQL_V4 },
  { version: 5, sql: ACCOUNTS_MIGRATION_5 },
  { version: 6, sql: ACCOUNTS_MIGRATION_6 },
  { version: 7, sql: ACCOUNTS_MIGRATION_7 },
  { version: 8, sql: `${ACCOUNTS_MIGRATION_8}\n${ACCOUNTS_RLS_SQL_V8}` },
  { version: 9, sql: buildAccountsMigration9Sql() },
  { version: 10, sql: buildAccountsMigration10Sql() },
  { version: 11, sql: `${ACCOUNTS_MIGRATION_11}\n${ACCOUNTS_RLS_SQL_V11}` },
  { version: 12, sql: ACCOUNTS_RLS_SQL_V12 },
  { version: 13, sql: ACCOUNTS_RLS_SQL_V13 },
  { version: 14, sql: ACCOUNTS_RLS_SQL_V14 },
  { version: 15, sql: ACCOUNTS_RLS_SQL_V15 },
  { version: 16, sql: ACCOUNTS_RLS_SQL_V16 },
  { version: 17, sql: ACCOUNTS_RLS_SQL_V17 },
  { version: 18, sql: ACCOUNTS_RLS_SQL_V18 },
  { version: 19, sql: ACCOUNTS_RLS_SQL_V19 },
  { version: 20, sql: ACCOUNTS_MIGRATION_20 },
  { version: 21, sql: ACCOUNTS_MIGRATION_21 },
  { version: 22, sql: ACCOUNTS_MIGRATION_22 },
  { version: 23, sql: ACCOUNTS_MIGRATION_23 },
  { version: 24, sql: ACCOUNTS_MIGRATION_24 },
  { version: 25, sql: ACCOUNTS_MIGRATION_25 },
  { version: 26, sql: ACCOUNTS_MIGRATION_26 },
  { version: 27, sql: ACCOUNTS_MIGRATION_27 },
  { version: 28, sql: ACCOUNTS_MIGRATION_28 },
  { version: 29, sql: ACCOUNTS_MIGRATION_29 },
  { version: 30, sql: ACCOUNTS_MIGRATION_30 },
  { version: 31, sql: ACCOUNTS_MIGRATION_31 },
  { version: 32, sql: ACCOUNTS_MIGRATION_32 },
] as const;

export function accountsMigrationChecksum(version: number): string {
  const migration = ACCOUNT_MIGRATIONS.find((item) => item.version === version);
  if (!migration) throw new Error(`unknown accounts version ${version}`);
  return createHash('sha256').update(migration.sql).digest('hex');
}

export function sqlContainsForceRowSecurity(sql: string): boolean {
  return /FORCE\s+ROW\s+LEVEL\s+SECURITY/i.test(sql);
}

export function classroomSessionRegistryChecksum(): string {
  return createHash('sha256').update(ACCOUNTS_MIGRATION_6).digest('hex');
}

export function classroomSessionRegistryRoleSyncChecksum(): string {
  return createHash('sha256').update(ACCOUNTS_MIGRATION_7).digest('hex');
}

/** psql-applicable classroom v6+v7 with RLS/row-count guards. No secrets. */
export function buildClassroomSessionRegistryApplySql(): string {
  if (
    sqlContainsForceRowSecurity(ACCOUNTS_MIGRATION_6) ||
    sqlContainsForceRowSecurity(ACCOUNTS_MIGRATION_7)
  ) {
    throw new Error('Classroom session registry SQL must not contain FORCE ROW LEVEL SECURITY');
  }
  const checksum = classroomSessionRegistryChecksum();
  const roleSyncChecksum = classroomSessionRegistryRoleSyncChecksum();
  return `
BEGIN;

DO $classroom_registry_guard$
BEGIN
  IF to_regclass('public.document_stages') IS NULL THEN
    RAISE EXCEPTION 'classroom session registry requires public.document_stages';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname IN ('document_stages', 'stage_meta', 'generation_jobs')
      AND (c.relrowsecurity OR c.relforcerowsecurity)
  ) THEN
    RAISE EXCEPTION 'refusing classroom registry apply because generation tables already have RLS or FORCE RLS';
  END IF;
END
$classroom_registry_guard$;

CREATE TEMP TABLE classroom_registry_before AS
SELECT
  (SELECT count(*) FROM document_stages) AS stages,
  (SELECT count(*) FROM document_stages WHERE owner_id LIKE 'anon:%') AS anon_stages,
  (SELECT count(*) FROM generation_jobs) AS jobs;

${ACCOUNTS_MIGRATION_6}

${ACCOUNTS_MIGRATION_7}

DO $classroom_registry_assert$
DECLARE
  rec record;
BEGIN
  SELECT * INTO STRICT rec FROM classroom_registry_before;
  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname IN ('document_stages', 'stage_meta', 'generation_jobs')
      AND (c.relrowsecurity OR c.relforcerowsecurity)
  ) THEN
    RAISE EXCEPTION 'classroom registry apply flipped RLS on generation tables';
  END IF;
  IF (SELECT count(*) FROM document_stages) <> rec.stages THEN
    RAISE EXCEPTION 'classroom registry apply changed document_stages row count';
  END IF;
  IF (SELECT count(*) FROM document_stages WHERE owner_id LIKE 'anon:%') <> rec.anon_stages THEN
    RAISE EXCEPTION 'classroom registry apply changed anon: document_stages row count';
  END IF;
  IF (SELECT count(*) FROM generation_jobs) <> rec.jobs THEN
    RAISE EXCEPTION 'classroom registry apply changed generation_jobs row count';
  END IF;
END
$classroom_registry_assert$;

CREATE TABLE IF NOT EXISTS app_schema_migrations(
  version INTEGER PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO app_schema_migrations(version, checksum)
SELECT ${CLASSROOM_SESSION_REGISTRY_VERSION}, '${checksum}'
WHERE NOT EXISTS (
  SELECT 1 FROM app_schema_migrations WHERE version = ${CLASSROOM_SESSION_REGISTRY_VERSION}
);

INSERT INTO app_schema_migrations(version, checksum)
SELECT ${CLASSROOM_SESSION_REGISTRY_ROLE_SYNC_VERSION}, '${roleSyncChecksum}'
WHERE NOT EXISTS (
  SELECT 1 FROM app_schema_migrations WHERE version = ${CLASSROOM_SESSION_REGISTRY_ROLE_SYNC_VERSION}
);

DO $classroom_registry_checksum$
DECLARE
  existing text;
  role_sync text;
BEGIN
  SELECT checksum INTO existing
  FROM app_schema_migrations
  WHERE version = ${CLASSROOM_SESSION_REGISTRY_VERSION};
  IF existing IS DISTINCT FROM '${checksum}' THEN
    RAISE EXCEPTION 'classroom session registry checksum mismatch';
  END IF;
  SELECT checksum INTO role_sync
  FROM app_schema_migrations
  WHERE version = ${CLASSROOM_SESSION_REGISTRY_ROLE_SYNC_VERSION};
  IF role_sync IS DISTINCT FROM '${roleSyncChecksum}' THEN
    RAISE EXCEPTION 'classroom session registry role-sync checksum mismatch';
  END IF;
END
$classroom_registry_checksum$;

COMMIT;
`;
}

function splitSql(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === '$') {
      const match = sql.slice(i).match(/^\$[a-zA-Z0-9_]*\$/);
      if (match) {
        const tag = match[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end === -1) {
          current += sql.slice(i);
          break;
        }
        current += sql.slice(i, end + tag.length);
        i = end + tag.length;
        continue;
      }
    }
    const ch = sql[i]!;
    if (ch === ';') {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = '';
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

async function generationTablesLackForceRls(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ relname: string }>(
    `SELECT c.relname
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND c.relname IN ('document_stages', 'stage_meta', 'generation_jobs')
        AND c.relforcerowsecurity = false`,
  );
  return result.rows.length > 0;
}

/** Runs migration SQL one statement at a time (dollar-quoted bodies stay whole). */
export async function applyStatements(
  client: { query(sql: string): Promise<unknown> },
  sql: string,
): Promise<void> {
  for (const statement of splitSql(sql)) {
    await client.query(statement);
  }
}

/** Operator entry; never called from request handlers or worker claim loops. */
export async function migrateAccountsSchema(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('openmaic:accounts:migrations'))");
    await client.query(
      'CREATE TABLE IF NOT EXISTS app_schema_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())',
    );
    const unprotected = await generationTablesLackForceRls(client);
    for (const migration of ACCOUNT_MIGRATIONS) {
      const checksum = createHash('sha256').update(migration.sql).digest('hex');
      const found = await client.query(
        'SELECT checksum FROM app_schema_migrations WHERE version=$1',
        [migration.version],
      );
      if (found.rows.length) {
        if ((found.rows[0] as { checksum: string }).checksum !== checksum) {
          throw new Error(`Accounts migration checksum mismatch (version ${migration.version})`);
        }
        continue;
      }
      if (unprotected && sqlContainsForceRowSecurity(migration.sql)) {
        throw new Error(
          'Refusing accounts FORCE RLS on live generation tables (document_stages / stage_meta / generation_jobs). Use migrateClassroomSessionRegistry for app_internal + app_accounts only.',
        );
      }
      await applyStatements(client, migration.sql);
      await client.query('INSERT INTO app_schema_migrations(version,checksum) VALUES($1,$2)', [
        migration.version,
        checksum,
      ]);
    }
    await client.query('COMMIT');
    console.info(`Accounts schema migration complete (version ${ACCOUNTS_SCHEMA_VERSION})`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

interface ClassroomRegistrySnapshot {
  stages: string;
  anonStages: string;
  jobs: string;
  stagesRls: boolean;
  stagesForce: boolean;
  jobsForce: boolean;
  metaForce: boolean;
}

async function readClassroomRegistrySnapshot(
  client: PoolClient,
): Promise<ClassroomRegistrySnapshot> {
  const tables = await client.query<{ relname: string }>(
    `SELECT c.relname
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND c.relname = 'document_stages'`,
  );
  if (!tables.rows.length) {
    throw new Error('Classroom session registry requires public.document_stages');
  }
  const flags = await client.query<{
    stages_rls: boolean;
    stages_force: boolean;
    jobs_force: boolean | null;
    meta_force: boolean | null;
  }>(
    `SELECT
        (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'document_stages') AS stages_rls,
        (SELECT c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'document_stages') AS stages_force,
        (SELECT c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'generation_jobs') AS jobs_force,
        (SELECT c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'stage_meta') AS meta_force`,
  );
  const row = flags.rows[0]!;
  if (row.stages_rls || row.stages_force || row.jobs_force || row.meta_force) {
    throw new Error(
      'Refusing classroom registry apply because generation tables already have RLS or FORCE RLS',
    );
  }
  const counts = await client.query<{ stages: string; anon_stages: string; jobs: string }>(
    `SELECT
        (SELECT count(*)::text FROM document_stages) AS stages,
        (SELECT count(*)::text FROM document_stages WHERE owner_id LIKE 'anon:%') AS anon_stages,
        (SELECT count(*)::text FROM generation_jobs) AS jobs`,
  );
  return {
    stages: counts.rows[0]!.stages,
    anonStages: counts.rows[0]!.anon_stages,
    jobs: counts.rows[0]!.jobs,
    stagesRls: row.stages_rls,
    stagesForce: row.stages_force,
    jobsForce: Boolean(row.jobs_force),
    metaForce: Boolean(row.meta_force),
  };
}

async function assertClassroomRegistrySnapshot(
  client: PoolClient,
  before: ClassroomRegistrySnapshot,
): Promise<void> {
  const after = await readClassroomRegistrySnapshot(client);
  if (after.stagesRls || after.stagesForce || after.jobsForce || after.metaForce) {
    throw new Error('Classroom registry apply flipped RLS on generation tables');
  }
  if (
    after.stages !== before.stages ||
    after.anonStages !== before.anonStages ||
    after.jobs !== before.jobs
  ) {
    throw new Error('Classroom registry apply changed generation row counts');
  }
}

async function applyClassroomRegistryVersion(
  client: PoolClient,
  version: number,
  sql: string,
): Promise<boolean> {
  if (sqlContainsForceRowSecurity(sql)) {
    throw new Error('Classroom session registry SQL must not contain FORCE ROW LEVEL SECURITY');
  }
  const checksum = createHash('sha256').update(sql).digest('hex');
  const found = await client.query('SELECT checksum FROM app_schema_migrations WHERE version=$1', [
    version,
  ]);
  if (found.rows.length) {
    if ((found.rows[0] as { checksum: string }).checksum !== checksum) {
      throw new Error(`Classroom session registry checksum mismatch (version ${version})`);
    }
    return false;
  }
  await applyStatements(client, sql);
  await client.query('INSERT INTO app_schema_migrations(version,checksum) VALUES($1,$2)', [
    version,
    checksum,
  ]);
  return true;
}

/**
 * Operator entry for the live dual-mode classroom database. Applies accounts
 * v6 then the v7 ensure_account role upsert. Never ENABLE/FORCE RLS on
 * document_stages.
 */
export async function migrateClassroomSessionRegistry(pool: Pool): Promise<{
  applied: boolean;
  checksum: string;
  roleSyncChecksum: string;
  stages: string;
  anonStages: string;
}> {
  const checksum = classroomSessionRegistryChecksum();
  const roleSyncChecksum = classroomSessionRegistryRoleSyncChecksum();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('openmaic:accounts:migrations'))");
    const before = await readClassroomRegistrySnapshot(client);
    await client.query(
      'CREATE TABLE IF NOT EXISTS app_schema_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())',
    );
    const appliedV6 = await applyClassroomRegistryVersion(
      client,
      CLASSROOM_SESSION_REGISTRY_VERSION,
      ACCOUNTS_MIGRATION_6,
    );
    const appliedV7 = await applyClassroomRegistryVersion(
      client,
      CLASSROOM_SESSION_REGISTRY_ROLE_SYNC_VERSION,
      ACCOUNTS_MIGRATION_7,
    );
    await assertClassroomRegistrySnapshot(client, before);
    await client.query('COMMIT');
    if (appliedV6 || appliedV7) {
      console.info(
        `Classroom session registry applied (v6=${appliedV6}, v7=${appliedV7}, stages=${before.stages}, anon=${before.anonStages})`,
      );
    }
    return {
      applied: appliedV6 || appliedV7,
      checksum,
      roleSyncChecksum,
      stages: before.stages,
      anonStages: before.anonStages,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
