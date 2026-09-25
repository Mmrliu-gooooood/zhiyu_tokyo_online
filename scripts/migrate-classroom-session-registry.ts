/**
 * Apply classroom accounts v6 + v7 (ensure_account role upsert) to the live
 * classroom Postgres. Never ENABLE/FORCE RLS on document_stages.
 *
 *   CLASSROOM_SESSION_REGISTRY_MIGRATE=1 DATABASE_URL=... pnpm accounts:migrate-classroom-registry
 *
 * `--print-sql` writes the v6 statements only (no secrets). Does not apply.
 * `--print-role-sync-sql` writes v7. `--print-apply-sql` wraps v6+v7 with guards.
 */
import { Pool } from 'pg';

import { ACCOUNTS_MIGRATION_6, ACCOUNTS_MIGRATION_7 } from '../lib/server/accounts/sql-accounts';
import {
  classroomSessionRegistryChecksum,
  classroomSessionRegistryRoleSyncChecksum,
  buildClassroomSessionRegistryApplySql,
  migrateClassroomSessionRegistry,
  sqlContainsForceRowSecurity,
} from '../lib/server/accounts/migrations';

function assertClassroomDatabaseUrl(connectionString: string): void {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL');
  }
  const host = parsed.hostname.toLowerCase();
  const db = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (host.includes('supabase.co') || host.startsWith('db.lvbtgwlsebzbtcvjwktq')) {
    throw new Error('Refusing classroom registry migrate against hosted Supabase');
  }
  if (db !== 'openmaic') {
    throw new Error('Classroom session registry migrate targets database openmaic only');
  }
  if (parsed.port === '55432') {
    throw new Error('Refusing classroom registry migrate against the throwaway RLS proof port');
  }
  if (host !== 'postgres' && host !== 'openmaic-main-postgres-1') {
    throw new Error('Classroom session registry migrate targets the compose postgres service only');
  }
}

async function main() {
  if (process.argv.includes('--print-sql')) {
    if (sqlContainsForceRowSecurity(ACCOUNTS_MIGRATION_6)) {
      throw new Error('Classroom session registry SQL must not contain FORCE ROW LEVEL SECURITY');
    }
    process.stdout.write(`${ACCOUNTS_MIGRATION_6.trim()}\n`);
    return;
  }
  if (process.argv.includes('--print-role-sync-sql')) {
    if (sqlContainsForceRowSecurity(ACCOUNTS_MIGRATION_7)) {
      throw new Error('Classroom session registry SQL must not contain FORCE ROW LEVEL SECURITY');
    }
    process.stdout.write(`${ACCOUNTS_MIGRATION_7.trim()}\n`);
    return;
  }
  if (process.argv.includes('--print-apply-sql')) {
    process.stdout.write(`${buildClassroomSessionRegistryApplySql().trim()}\n`);
    return;
  }
  if (process.argv.includes('--print-checksum')) {
    process.stdout.write(`${classroomSessionRegistryChecksum()}\n`);
    return;
  }
  if (process.argv.includes('--print-role-sync-checksum')) {
    process.stdout.write(`${classroomSessionRegistryRoleSyncChecksum()}\n`);
    return;
  }
  if (process.env.CLASSROOM_SESSION_REGISTRY_MIGRATE !== '1') {
    throw new Error('Set CLASSROOM_SESSION_REGISTRY_MIGRATE=1 to apply the classroom session registry');
  }
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error('DATABASE_URL is required');
  }
  assertClassroomDatabaseUrl(connectionString);
  const pool = new Pool({ connectionString });
  try {
    const result = await migrateClassroomSessionRegistry(pool);
    console.info(
      JSON.stringify({
        applied: result.applied,
        checksum: result.checksum,
        roleSyncChecksum: result.roleSyncChecksum,
        stages: result.stages,
        anonStages: result.anonStages,
      }),
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
