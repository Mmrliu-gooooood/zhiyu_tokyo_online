/**
 * Isolation proofs against a throwaway Postgres. Refuses the live openmaic DB.
 *
 *   ACCOUNTS_RLS_PROOF=1 DATABASE_URL=postgres://proof_admin@127.0.0.1:55432/accounts_rls_proof \
 *     pnpm exec tsx scripts/prove-accounts-rls.ts
 */
import { Pool } from 'pg';

import { migrateAccountsSchema } from '../lib/server/accounts/migrations';

const STUB_SQL = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY,
  email text,
  raw_user_meta_data jsonb
);
CREATE TABLE IF NOT EXISTS auth.sessions (
  id uuid PRIMARY KEY,
  user_id uuid
);

CREATE TABLE IF NOT EXISTS document_folders (
  id text PRIMARY KEY,
  owner_id text
);
CREATE TABLE IF NOT EXISTS document_stages (
  id text PRIMARY KEY,
  owner_id text
);
CREATE TABLE IF NOT EXISTS stage_meta (
  stage_id text PRIMARY KEY,
  owner_id text
);
CREATE TABLE IF NOT EXISTS document_scenes (
  stage_id text NOT NULL,
  id text NOT NULL,
  PRIMARY KEY (stage_id, id)
);
CREATE TABLE IF NOT EXISTS document_outlines (
  stage_id text PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS runtime_sessions (
  id text PRIMARY KEY,
  learner_key text,
  stage_id text
);
CREATE TABLE IF NOT EXISTS runtime_records (
  id text PRIMARY KEY,
  session_id text
);
CREATE TABLE IF NOT EXISTS asset_entries (
  id text PRIMARY KEY,
  principal text,
  content_hash text
);
CREATE TABLE IF NOT EXISTS asset_blobs (
  content_hash text PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS owner_material (
  id text PRIMARY KEY,
  owner_id text
);
CREATE TABLE IF NOT EXISTS document_stage_revision (
  stage_id text PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS document_scene_revision (
  stage_id text NOT NULL,
  id text NOT NULL,
  PRIMARY KEY (stage_id, id)
);
CREATE TABLE IF NOT EXISTS generation_ownership (
  job_id text PRIMARY KEY,
  owner_id text
);
CREATE TABLE IF NOT EXISTS generation_scenes (
  id text PRIMARY KEY,
  job_id text
);
CREATE TABLE IF NOT EXISTS generation_steps (
  id text PRIMARY KEY,
  job_id text
);
CREATE TABLE IF NOT EXISTS generation_attempts (
  id text PRIMARY KEY,
  job_id text
);
CREATE TABLE IF NOT EXISTS generation_job_assets (
  id text PRIMARY KEY,
  job_id text
);
CREATE TABLE IF NOT EXISTS generation_events (
  id text PRIMARY KEY,
  job_id text
);
CREATE TABLE IF NOT EXISTS generation_commands (
  id text PRIMARY KEY,
  job_id text
);
CREATE TABLE IF NOT EXISTS generation_provider_slots (
  id text PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS generation_worker_heartbeats (
  id text PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS generation_schema_migrations (
  version integer PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS media_config_snapshots (
  id text PRIMARY KEY,
  owner_id text
);
CREATE TABLE IF NOT EXISTS generation_model_snapshots (
  id text PRIMARY KEY,
  owner_id text
);
CREATE TABLE IF NOT EXISTS generation_search_snapshots (
  id text PRIMARY KEY,
  owner_id text
);
`;

function assertThrowawayUrl(connectionString: string): void {
  const parsed = new URL(connectionString);
  const db = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (db === 'openmaic') {
    throw new Error('Refusing to run the RLS proof against database openmaic');
  }
  if (parsed.port === '5432' && (parsed.hostname === 'postgres' || parsed.hostname === 'localhost')) {
    throw new Error('Refusing to run the RLS proof against default Postgres port 5432');
  }
}

async function main(): Promise<void> {
  if (process.env.ACCOUNTS_RLS_PROOF !== '1') {
    throw new Error('Set ACCOUNTS_RLS_PROOF=1 to run this throwaway proof');
  }
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error('DATABASE_URL is required');
  }
  assertThrowawayUrl(connectionString);

  const admin = new Pool({ connectionString, max: 1 });
  const results: Record<string, unknown> = {};
  try {
    await admin.query(STUB_SQL);
    await migrateAccountsSchema(admin);

    const versions = await admin.query('SELECT version FROM app_schema_migrations ORDER BY version');
    results.appliedVersions = versions.rows.map((row) => Number((row as { version: number }).version));

    const userA = '11111111-1111-4111-8111-111111111111';
    const userB = '22222222-2222-4222-8222-222222222222';
    const ownerA = `user:${userA}`;
    const ownerB = `user:${userB}`;

    await admin.query(
      `INSERT INTO auth.users (id, email, raw_user_meta_data)
       VALUES ($1::uuid, 'a@example.test', '{}'::jsonb), ($2::uuid, 'b@example.test', '{}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [userA, userB],
    );
    await admin.query(
      `INSERT INTO app_accounts (user_id, owner_id, role, status)
       VALUES ($1::uuid, $2, 'user', 'active'), ($3::uuid, $4, 'user', 'active')
       ON CONFLICT (user_id) DO NOTHING`,
      [userA, ownerA, userB, ownerB],
    );
    await admin.query(
      `INSERT INTO document_stages (id, owner_id) VALUES ('stage-a', $1), ('stage-b', $2)
       ON CONFLICT (id) DO UPDATE SET owner_id = EXCLUDED.owner_id`,
      [ownerA, ownerB],
    );

    const asWeb = async (sql: string, params: unknown[] = []) => {
      const client = await admin.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE app_web');
        const result = await client.query(sql, params);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* keep original */
        }
        throw error;
      } finally {
        client.release();
      }
    };

    const noContext = await asWeb('SELECT id FROM document_stages ORDER BY id');
    results.appWebNoOwnerContext = noContext.rows.length;

    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_web');
      await client.query('SELECT set_config($1, $2, true)', ['app.owner_id', ownerA]);
      const visible = await client.query('SELECT id FROM document_stages ORDER BY id');
      results.appWebOwnerASees = visible.rows.map((row) => (row as { id: string }).id);
      const stolen = await client.query(
        `UPDATE document_stages SET owner_id = $1 WHERE id = 'stage-b' RETURNING id`,
        [ownerA],
      );
      results.appWebOwnerAUpdatedB = stolen.rowCount ?? 0;
      await client.query('COMMIT');
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* keep original */
      }
      throw error;
    } finally {
      client.release();
    }

    const stillB = await admin.query(`SELECT owner_id FROM document_stages WHERE id = 'stage-b'`);
    results.stageBOwnerUnchanged = (stillB.rows[0] as { owner_id: string } | undefined)?.owner_id;

    const worker = await admin.connect();
    try {
      await worker.query('BEGIN');
      await worker.query('SET LOCAL ROLE app_worker');
      const all = await worker.query('SELECT id FROM document_stages ORDER BY id');
      results.appWorkerSees = all.rows.map((row) => (row as { id: string }).id);
      await worker.query('COMMIT');
    } catch (error) {
      try {
        await worker.query('ROLLBACK');
      } catch {
        /* keep original */
      }
      throw error;
    } finally {
      worker.release();
    }

    const publicGrants = await admin.query(
      `SELECT grantee, privilege_type
         FROM information_schema.role_table_grants
        WHERE table_schema = 'public'
          AND table_name = 'document_stages'
          AND grantee IN ('PUBLIC', 'anon', 'authenticated')`,
    );
    results.publicAnonAuthenticatedGrants = publicGrants.rows.length;
    const anonSelect = await admin.query(`SELECT has_table_privilege('anon', 'document_stages', 'SELECT') AS allowed`);
    const authenticatedSelect = await admin.query(
      `SELECT has_table_privilege('authenticated', 'document_stages', 'SELECT') AS allowed`,
    );
    results.anonCanSelectStages = Boolean((anonSelect.rows[0] as { allowed: boolean }).allowed);
    results.authenticatedCanSelectStages = Boolean(
      (authenticatedSelect.rows[0] as { allowed: boolean }).allowed,
    );

    const nickId = '33333333-3333-4333-8333-333333333333';
    await admin.query(
      `INSERT INTO auth.users (id, email, raw_user_meta_data)
       VALUES ($1::uuid, 'nickname-admin@example.test', $2::jsonb)`,
      [nickId, JSON.stringify({ role: 'admin', display_name: 'admin' })],
    );
    const created = await admin.query(
      `SELECT a.role AS account_role, p.display_name
         FROM app_accounts a
         JOIN app_profiles p ON p.user_id = a.user_id
        WHERE a.user_id = $1::uuid`,
      [nickId],
    );
    results.nicknameAdmin = created.rows[0] ?? null;

    const failures: string[] = [];
    if (JSON.stringify(results.appliedVersions) !== JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8])) {
      failures.push(`expected versions 1-8, got ${JSON.stringify(results.appliedVersions)}`);
    }
    if (results.appWebNoOwnerContext !== 0) failures.push('app_web without owner context must see 0 stages');
    if (JSON.stringify(results.appWebOwnerASees) !== JSON.stringify(['stage-a'])) {
      failures.push(`owner A must see only stage-a, got ${JSON.stringify(results.appWebOwnerASees)}`);
    }
    if (results.appWebOwnerAUpdatedB !== 0) failures.push('owner A must not UPDATE B rows');
    if (results.stageBOwnerUnchanged !== ownerB) failures.push('stage-b owner must stay B');
    if (JSON.stringify(results.appWorkerSees) !== JSON.stringify(['stage-a', 'stage-b'])) {
      failures.push(`app_worker must see both stages, got ${JSON.stringify(results.appWorkerSees)}`);
    }
    if (results.publicAnonAuthenticatedGrants !== 0) failures.push('PUBLIC/anon/authenticated must have no table grants');
    if (results.anonCanSelectStages) failures.push('anon must not SELECT document_stages');
    if (results.authenticatedCanSelectStages) failures.push('authenticated must not SELECT document_stages');
    const nick = results.nicknameAdmin as { account_role?: string; display_name?: string } | null;
    if (!nick || nick.account_role !== 'user') {
      failures.push('Auth nickname/metadata role=admin must still create account role=user');
    }
    if (nick?.display_name !== 'admin') {
      failures.push('display_name admin is allowed; it must not grant account role');
    }

    results.ok = failures.length === 0;
    results.failures = failures;
    console.info(JSON.stringify(results, null, 2));
    if (failures.length) {
      throw new Error(failures.join('; '));
    }
  } finally {
    await admin.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
