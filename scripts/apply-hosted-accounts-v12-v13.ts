/** Apply only the additive hosted accounts v12-v18 migrations.
 *
 * The existing zhiyu project has legitimate pre-v11 migration history from a
 * different deployment branch, so the generic from-v1 migrator must not be
 * used to rewrite those checksums.
 */
import { createHash } from 'node:crypto';

import {
  ACCOUNTS_RLS_SQL_V12,
  ACCOUNTS_RLS_SQL_V13,
  ACCOUNTS_RLS_SQL_V14,
  ACCOUNTS_RLS_SQL_V15,
  ACCOUNTS_RLS_SQL_V16,
  ACCOUNTS_RLS_SQL_V17,
  ACCOUNTS_RLS_SQL_V18,
} from '../lib/server/accounts/sql-rls';
import {
  hostedPgPool,
  hostedRoleFromUsername,
  isHostedDbHost,
  loadHostedOperatorEnv,
} from './lib/hosted-operator-env';

const migrations = [
  { version: 12, sql: ACCOUNTS_RLS_SQL_V12 },
  { version: 13, sql: ACCOUNTS_RLS_SQL_V13 },
  { version: 14, sql: ACCOUNTS_RLS_SQL_V14 },
  { version: 15, sql: ACCOUNTS_RLS_SQL_V15 },
  { version: 16, sql: ACCOUNTS_RLS_SQL_V16 },
  { version: 17, sql: ACCOUNTS_RLS_SQL_V17 },
  { version: 18, sql: ACCOUNTS_RLS_SQL_V18 },
] as const;

function redact(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, 'postgresql://***@')
    .replace(/password[=:]\s*\S+/gi, 'password=***');
}

async function main() {
  loadHostedOperatorEnv();
  const url =
    process.env.HOSTED_DB_ADMIN_URL?.trim() ||
    process.env.GENERATION_MIGRATION_DATABASE_URL?.trim();
  if (!url) throw new Error('hosted admin URL is required');
  const parsed = new URL(url);
  if (!isHostedDbHost(parsed.hostname) || hostedRoleFromUsername(parsed.username) !== 'postgres') {
    throw new Error('refusing non-hosted or non-admin database URL');
  }

  const pool = hostedPgPool(url);
  const client = await pool.connect();
  const applied: number[] = [];
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('openmaic:accounts:migrations'))");
    const database = await client.query<{ name: string }>('SELECT current_database() AS name');
    if (database.rows[0]?.name === 'openmaic') throw new Error('refusing classroom database');
    const baseline = await client.query<{ present: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM app_schema_migrations WHERE version=11) AS present',
    );
    if (!baseline.rows[0]?.present) throw new Error('accounts v11 baseline is required');

    for (const migration of migrations) {
      const checksum = createHash('sha256').update(migration.sql).digest('hex');
      const found = await client.query<{ checksum: string }>(
        'SELECT checksum FROM app_schema_migrations WHERE version=$1',
        [migration.version],
      );
      if (found.rows.length) {
        if (found.rows[0]!.checksum !== checksum) {
          throw new Error(`accounts migration checksum mismatch (version ${migration.version})`);
        }
        continue;
      }
      await client.query(migration.sql);
      await client.query('INSERT INTO app_schema_migrations(version,checksum) VALUES($1,$2)', [
        migration.version,
        checksum,
      ]);
      applied.push(migration.version);
    }

    const proof = await client.query<{
      foreground: boolean;
      capacity: boolean;
      readiness: boolean;
      eventSequence: boolean;
      assetBlobLock: boolean;
      assetBlobMutations: boolean;
    }>(
      `SELECT
         to_regprocedure('app_internal.acquire_foreground_generation_root(text,uuid,bigint,bigint,bigint,integer,integer,integer)') IS NOT NULL AS foreground,
         to_regprocedure('app_internal.heavy_task_capacity(text,text,text,bigint,bigint,bigint,bigint,bigint,integer,integer,boolean)') IS NOT NULL AS capacity,
         to_regprocedure('app_internal.deployment_readiness(jsonb)') IS NOT NULL AS readiness,
         has_sequence_privilege('zhiyu_app_web', 'public.generation_events_id_seq', 'USAGE')
           AND has_sequence_privilege('zhiyu_app_worker', 'public.generation_events_id_seq', 'USAGE')
           AS "eventSequence",
         has_column_privilege('zhiyu_app_web', 'public.asset_blobs', 'content_hash', 'UPDATE')
           AND EXISTS (
             SELECT 1 FROM pg_policies
              WHERE schemaname='public' AND tablename='asset_blobs'
                AND policyname='asset_blobs_web_lock'
           ) AS "assetBlobLock",
         to_regprocedure('app_internal.claim_asset_blob(text,bigint)') IS NOT NULL
           AND to_regprocedure('app_internal.release_asset_blob(text)') IS NOT NULL
           AS "assetBlobMutations"`,
    );
    if (
      !proof.rows[0]?.foreground ||
      !proof.rows[0]?.capacity ||
      !proof.rows[0]?.readiness ||
      !proof.rows[0]?.eventSequence ||
      !proof.rows[0]?.assetBlobLock ||
      !proof.rows[0]?.assetBlobMutations
    ) {
      throw new Error('accounts v12-v18 security proof failed');
    }
    await client.query('COMMIT');
    console.info(JSON.stringify({ ok: true, applied, versions: [12, 13, 14, 15, 16, 17, 18] }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw new Error(redact(error));
  } finally {
    client.release();
    await pool.end().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(redact(error));
  process.exit(1);
});
