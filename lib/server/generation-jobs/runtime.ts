import { Pool } from 'pg';
import {
  GENERATION_PIPELINE_VERSION,
  GENERATION_SCHEMA_VERSION,
  GenerationJobError,
} from './contracts';

let state: { url: string; pool: Pool } | undefined;
export function backgroundGenerationEnabled(): boolean {
  return process.env.GENERATION_BACKGROUND_ENABLED === '1';
}
export function acceptingGenerationJobs(): boolean {
  return backgroundGenerationEnabled() && process.env.GENERATION_ACCEPTING_JOBS === '1';
}
/** Readiness and HTTP never bootstrap schema. Only the migration CLI runs DDL. */
export function getGenerationPool(): Pool {
  const url = process.env.DATABASE_URL;
  if (!url) throw new GenerationJobError('GENERATION_DATABASE_UNAVAILABLE', 503);
  if (state?.url === url) return state.pool;
  const pool = new Pool({
    connectionString: url,
    max: 8,
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
    idleTimeoutMillis: 30000,
  });
  pool.on('error', () => {
    /* No credentials or connection strings in diagnostics. */
  });
  const previous = state;
  state = { url, pool };
  void previous?.pool.end().catch(() => {});
  return pool;
}
export async function generationReadiness() {
  let database = false;
  let schema = false;
  let worker = false;
  try {
    const pool = getGenerationPool();
    await pool.query('SELECT 1');
    database = true;
    const version = await pool.query(
      'SELECT MAX(version) AS version FROM generation_schema_migrations',
    );
    schema = Number(version.rows[0]?.version) === GENERATION_SCHEMA_VERSION;
    if (schema) {
      const live = await pool.query(
        "SELECT 1 FROM generation_worker_heartbeats WHERE heartbeat_at > clock_timestamp() - interval '30 seconds' AND NOT draining AND pipeline_versions @> $1::jsonb LIMIT 1",
        [JSON.stringify([GENERATION_PIPELINE_VERSION])],
      );
      worker = live.rowCount !== 0;
    }
  } catch {
    /* Deliberately return a safe, bounded readiness result. */
  }
  return {
    database,
    schema,
    worker,
    accepting: acceptingGenerationJobs() && database && schema,
    pipelineVersion: GENERATION_PIPELINE_VERSION,
  };
}
export async function assertGenerationReady(submitting = false): Promise<void> {
  if (!backgroundGenerationEnabled() || (submitting && !acceptingGenerationJobs()))
    throw new GenerationJobError('GENERATION_MAINTENANCE', 503);
  const status = await generationReadiness();
  if (!status.database || !status.schema) throw new GenerationJobError('GENERATION_NOT_READY', 503);
}
