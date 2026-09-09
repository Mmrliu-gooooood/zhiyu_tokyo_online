import { createHash } from 'node:crypto';
import type { Queryable } from '@openmaic/storage/document/pg';
import type { TransactionSource } from '@/lib/persistence/owner-bound-document-store';
import { GENERATION_SCHEMA_VERSION } from './contracts';

/** Additive migration only. Existing document/asset schemas must be migrated first. */
export const GENERATION_MIGRATION_1 = `
CREATE TABLE generation_jobs (
 id UUID PRIMARY KEY, stage_id TEXT NOT NULL UNIQUE REFERENCES document_stages(id) ON DELETE RESTRICT,
 owner_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','running','awaiting_confirmation','retry_wait','needs_attention','succeeded','failed','cancelled')),
 phase TEXT NOT NULL DEFAULT 'preparing' CHECK(phase IN ('preparing','researching','outlines','agents','scene_content','scene_actions','tts','media','finalizing')),
 run_no INTEGER NOT NULL DEFAULT 1, state_version BIGINT NOT NULL DEFAULT 1,
 pipeline_version TEXT NOT NULL, input_schema_version INTEGER NOT NULL DEFAULT 1, config_version TEXT NOT NULL,
 priority INTEGER NOT NULL DEFAULT 0, available_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 worker_id TEXT, lease_epoch BIGINT NOT NULL DEFAULT 0, lease_expires_at TIMESTAMPTZ, heartbeat_at TIMESTAMPTZ,
 input_snapshot JSONB NOT NULL, plan_revision INTEGER NOT NULL DEFAULT 0,
 review_policy TEXT NOT NULL CHECK(review_policy IN ('manual','auto')), review_hold BOOLEAN NOT NULL DEFAULT false, auto_continue_at TIMESTAMPTZ,
 total_scenes INTEGER NOT NULL DEFAULT 0, ready_scenes INTEGER NOT NULL DEFAULT 0, warning_count INTEGER NOT NULL DEFAULT 0,
 cancel_requested_at TIMESTAMPTZ, last_error_code TEXT, last_error_summary TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ,
 active_elapsed_ms BIGINT NOT NULL DEFAULT 0, editable_revision BIGINT,
 UNIQUE(owner_id,idempotency_key)
);
CREATE TABLE generation_ownership (
 stage_id TEXT PRIMARY KEY REFERENCES document_stages(id) ON DELETE RESTRICT, owner_id TEXT NOT NULL,
 producer_kind TEXT NOT NULL CHECK(producer_kind IN ('course-worker','agent-runtime','client')), producer_ref TEXT,
 ownership_epoch BIGINT NOT NULL DEFAULT 1, write_mode TEXT NOT NULL CHECK(write_mode IN ('generating','editable','deleted')),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE generation_scenes (
 job_id UUID NOT NULL REFERENCES generation_jobs(id), outline_id TEXT NOT NULL, scene_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
 outline JSONB NOT NULL, plan_revision INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', content JSONB, actions JSONB,
 previous_speeches_hash TEXT, content_hash TEXT, ready_at TIMESTAMPTZ, error_code TEXT,
 PRIMARY KEY(job_id,outline_id), UNIQUE(job_id,ordinal), UNIQUE(job_id,scene_id)
);
CREATE TABLE generation_steps (
 id UUID PRIMARY KEY, job_id UUID NOT NULL REFERENCES generation_jobs(id), step_key TEXT NOT NULL, kind TEXT NOT NULL, outline_id TEXT,
 dependency_hash TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','running','retry_wait','succeeded','skipped','failed','uncertain','cancelled')),
 attempt_count INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
 available_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), started_at TIMESTAMPTZ, deadline_at TIMESTAMPTZ,
 result JSONB, error_code TEXT, UNIQUE(job_id,step_key)
);
CREATE TABLE generation_attempts (
 id UUID PRIMARY KEY, step_id UUID NOT NULL REFERENCES generation_steps(id), attempt_no INTEGER NOT NULL,
 lease_epoch BIGINT NOT NULL, provider_config_ref TEXT NOT NULL, request_key TEXT NOT NULL, request_hash TEXT NOT NULL,
 provider_request_id TEXT, outcome TEXT NOT NULL CHECK(outcome IN ('running','succeeded','safe_failure','uncertain','cancelled')),
 started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), finished_at TIMESTAMPTZ, usage JSONB,
 UNIQUE(step_id,attempt_no)
);
CREATE TABLE generation_job_assets (
 job_id UUID NOT NULL REFERENCES generation_jobs(id), logical_key TEXT NOT NULL, asset_id TEXT NOT NULL REFERENCES asset_entries(id) ON DELETE RESTRICT,
 asset_revision INTEGER NOT NULL, content_hash TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('input','output')), scene_id TEXT,
 lifecycle TEXT NOT NULL CHECK(lifecycle IN ('staged','attached','released')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(job_id,logical_key)
);
CREATE TABLE generation_events (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, job_id UUID NOT NULL REFERENCES generation_jobs(id), run_no INTEGER NOT NULL,
 state_version BIGINT NOT NULL, type TEXT NOT NULL, payload JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE generation_commands (
 job_id UUID NOT NULL REFERENCES generation_jobs(id), command_key TEXT NOT NULL, kind TEXT NOT NULL, request_hash TEXT NOT NULL,
 result_version BIGINT NOT NULL, result JSONB NOT NULL, PRIMARY KEY(job_id,command_key)
);
CREATE TABLE generation_provider_slots (
 quota_group TEXT NOT NULL, slot_no INTEGER NOT NULL, holder_attempt_id UUID, lease_epoch BIGINT NOT NULL DEFAULT 0,
 expires_at TIMESTAMPTZ, quarantine_until TIMESTAMPTZ, cooldown_until TIMESTAMPTZ, PRIMARY KEY(quota_group,slot_no)
);
CREATE TABLE generation_worker_heartbeats (
 worker_id TEXT PRIMARY KEY, pipeline_versions JSONB NOT NULL, started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), draining BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX generation_jobs_claim_idx ON generation_jobs(priority DESC,available_at,created_at,id) WHERE status IN ('queued','retry_wait');
CREATE INDEX generation_jobs_lease_idx ON generation_jobs(lease_expires_at) WHERE status='running';
CREATE INDEX generation_jobs_owner_idx ON generation_jobs(owner_id,created_at DESC,id);
CREATE INDEX generation_jobs_review_idx ON generation_jobs(auto_continue_at) WHERE status='awaiting_confirmation';
CREATE INDEX generation_steps_status_idx ON generation_steps(job_id,status,available_at);
CREATE INDEX generation_events_cursor_idx ON generation_events(job_id,id);
CREATE INDEX generation_assets_asset_idx ON generation_job_assets(asset_id);
`;
export const GENERATION_MIGRATION_2 = `
CREATE TABLE media_config_snapshots (
 id UUID PRIMARY KEY, owner_id TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
 schema_version INTEGER NOT NULL CHECK(schema_version > 0),
 ciphertext TEXT NOT NULL, intent_digest TEXT NOT NULL,
 provider_instance_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), revoked_at TIMESTAMPTZ,
 UNIQUE(id,revision)
);
CREATE INDEX media_config_snapshots_owner_idx ON media_config_snapshots(owner_id,created_at DESC,id);
CREATE UNIQUE INDEX media_config_snapshots_active_intent_idx
 ON media_config_snapshots(owner_id,intent_digest) WHERE revoked_at IS NULL;
`;
export const GENERATION_MIGRATION_3 = `
CREATE TABLE generation_model_snapshots (
 id UUID PRIMARY KEY, owner_id TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
 schema_version INTEGER NOT NULL CHECK(schema_version > 0),
 ciphertext TEXT NOT NULL, intent_digest TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), revoked_at TIMESTAMPTZ,
 UNIQUE(id,revision)
);
CREATE INDEX generation_model_snapshots_owner_idx ON generation_model_snapshots(owner_id,created_at DESC,id);
CREATE UNIQUE INDEX generation_model_snapshots_active_intent_idx
 ON generation_model_snapshots(owner_id,intent_digest) WHERE revoked_at IS NULL;
`;
export const GENERATION_MIGRATION_4 = `
CREATE TABLE generation_search_snapshots (
 id UUID PRIMARY KEY, owner_id TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
 schema_version INTEGER NOT NULL CHECK(schema_version > 0),
 ciphertext TEXT NOT NULL, intent_digest TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), revoked_at TIMESTAMPTZ,
 UNIQUE(id,revision)
);
CREATE INDEX generation_search_snapshots_owner_idx ON generation_search_snapshots(owner_id,created_at DESC,id);
CREATE UNIQUE INDEX generation_search_snapshots_active_intent_idx
 ON generation_search_snapshots(owner_id,intent_digest) WHERE revoked_at IS NULL;
`;
export const GENERATION_MIGRATIONS = [
  { version: 1, sql: GENERATION_MIGRATION_1 },
  { version: 2, sql: GENERATION_MIGRATION_2 },
  { version: 3, sql: GENERATION_MIGRATION_3 },
  { version: 4, sql: GENERATION_MIGRATION_4 },
] as const;

/** Explicit operator entry point; never called by readiness, an API or worker bootstrap. */
export async function migrateGenerationSchema(pool: TransactionSource): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('openmaic:generation:migrations'))");
    await client.query(
      'CREATE TABLE IF NOT EXISTS generation_schema_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())',
    );
    for (const migration of GENERATION_MIGRATIONS) {
      const checksum = createHash('sha256').update(migration.sql).digest('hex');
      const found = await client.query(
        'SELECT checksum FROM generation_schema_migrations WHERE version=$1',
        [migration.version],
      );
      if (found.rows.length) {
        if ((found.rows[0] as { checksum: string }).checksum !== checksum)
          throw new Error('Generation migration checksum mismatch');
        continue;
      }
      // Schema statements contain no function bodies; one query per statement supports pg and PGlite.
      for (const sql of migration.sql
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean))
        await client.query(sql);
      await client.query(
        'INSERT INTO generation_schema_migrations(version,checksum) VALUES($1,$2)',
        [migration.version, checksum],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
export async function getGenerationSchemaVersion(q: Queryable): Promise<number> {
  const tables = await q.query<{ name: string | null }>(
    "SELECT to_regclass('generation_schema_migrations')::text AS name",
  );
  if (!tables.rows[0]?.name) return 0;
  const result = await q.query<{ version: number }>(
    'SELECT COALESCE(MAX(version),0)::int AS version FROM generation_schema_migrations',
  );
  return Number(result.rows[0]?.version ?? 0);
}
export async function assertGenerationSchema(q: Queryable): Promise<void> {
  if ((await getGenerationSchemaVersion(q)) !== GENERATION_SCHEMA_VERSION)
    throw new Error('Generation schema unavailable or incompatible');
}
