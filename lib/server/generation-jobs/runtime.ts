import type { Pool } from 'pg';
import { isHostedAuthEnabled } from '@/lib/auth/mode';
import {
  getGenerationRequestPool as getGenerationRequestPoolFromRegistry,
  getSystemPool,
} from '@/lib/db/pool-registry';
import {
  GENERATION_PIPELINE_VERSION,
  GENERATION_SCHEMA_VERSION,
  GenerationJobError,
} from './contracts';

export function backgroundGenerationEnabled(): boolean {
  return process.env.GENERATION_BACKGROUND_ENABLED === '1';
}
export function acceptingGenerationJobs(): boolean {
  return backgroundGenerationEnabled() && process.env.GENERATION_ACCEPTING_JOBS === '1';
}
export function generationAccepting(
  configured: boolean,
  health: { database: boolean; schema: boolean; worker: boolean },
): boolean {
  return configured && health.database && health.schema && health.worker;
}
/** Readiness and HTTP never bootstrap schema. Only the migration CLI runs DDL. */
export function getGenerationPool(): Pool {
  try {
    return getSystemPool();
  } catch {
    throw new GenerationJobError('GENERATION_DATABASE_UNAVAILABLE', 503);
  }
}

/** Owner-facing HTTP/control-plane reads use app_web, never app_worker. */
export function getGenerationRequestPool(): Pool {
  try {
    return getGenerationRequestPoolFromRegistry();
  } catch {
    throw new GenerationJobError('GENERATION_DATABASE_UNAVAILABLE', 503);
  }
}

async function readGenerationReadiness(pool: Pick<Pool, 'query'>) {
  let database = false;
  let schema = false;
  let worker = false;
  try {
    await pool.query('SELECT 1');
    database = true;
    if (isHostedAuthEnabled()) {
      const readiness = await pool.query<{
        schema_version: number | string;
        worker_live: boolean;
      }>('SELECT * FROM app_internal.generation_readiness()');
      schema = Number(readiness.rows[0]?.schema_version) === GENERATION_SCHEMA_VERSION;
      worker = schema && readiness.rows[0]?.worker_live === true;
      return {
        database,
        schema,
        worker,
        accepting: generationAccepting(acceptingGenerationJobs(), { database, schema, worker }),
        pipelineVersion: GENERATION_PIPELINE_VERSION,
      };
    }
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
    accepting: generationAccepting(acceptingGenerationJobs(), { database, schema, worker }),
    pipelineVersion: GENERATION_PIPELINE_VERSION,
  };
}

/** System/worker readiness for background process health checks. */
export function generationReadiness() {
  try {
    return readGenerationReadiness(getGenerationPool());
  } catch {
    return Promise.resolve(unavailableReadiness());
  }
}

/** Web readiness through app_web. DB grants expose only schema + heartbeat reads. */
export function generationRequestReadiness() {
  try {
    return readGenerationReadiness(getGenerationRequestPool());
  } catch {
    return Promise.resolve(unavailableReadiness());
  }
}

function unavailableReadiness() {
  return {
    database: false,
    schema: false,
    worker: false,
    accepting: false,
    pipelineVersion: GENERATION_PIPELINE_VERSION,
  };
}
export async function assertGenerationReady(submitting = false): Promise<void> {
  if (!backgroundGenerationEnabled() || (submitting && !acceptingGenerationJobs()))
    throw new GenerationJobError('GENERATION_MAINTENANCE', 503);
  const status = await generationReadiness();
  if (!status.database || !status.schema || (submitting && !status.worker))
    throw new GenerationJobError('GENERATION_NOT_READY', 503);
}

export async function assertGenerationRequestReady(submitting = false): Promise<void> {
  if (!backgroundGenerationEnabled() || (submitting && !acceptingGenerationJobs()))
    throw new GenerationJobError('GENERATION_MAINTENANCE', 503);
  const status = await generationRequestReadiness();
  if (!status.database || !status.schema || (submitting && !status.worker))
    throw new GenerationJobError('GENERATION_NOT_READY', 503);
}
