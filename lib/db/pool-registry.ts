import type { Pool } from 'pg';

import { isHostedAuthEnabled } from '@/lib/auth/mode';
import { createAppPool, HOSTED_POOL_DEFAULTS } from '@/lib/db/app-pool';
import { getPersistenceDatabaseUrl, getSystemDatabaseUrl } from '@/lib/db/database-urls';

interface PoolRegistryState {
  pools: Map<string, Pool>;
}

const POOL_REGISTRY_KEY = Symbol.for('openmaic.db.pool-registry');
const globalState = globalThis as typeof globalThis & {
  [POOL_REGISTRY_KEY]?: PoolRegistryState;
};
const state = (globalState[POOL_REGISTRY_KEY] ??= { pools: new Map() });

function poolLimit(connectionString: string): number {
  // In legacy mode the web and worker roles deliberately share DATABASE_URL.
  // Size that single pool for worker demand instead of making whichever caller
  // happens to initialize first decide the process-wide connection limit.
  try {
    if (connectionString === getSystemDatabaseUrl()) {
      // Each worker runs three independent short-query schedulers (generation,
      // Pro sessions and material extraction). A pool of two deterministically
      // starves one scheduler whenever their one-second scans align. Two
      // worker processes at max=3 plus one dedicated LISTEN session each use
      // eight app_worker sessions, leaving two of the session pooler's ten
      // backend slots for readiness/operator probes. Container health reads a
      // local marker written only after the durable heartbeat succeeds, so it
      // opens no additional database session. Generation-root concurrency is
      // enforced separately and never reserves one connection per root.
      return isHostedAuthEnabled() ? 3 : 8;
    }
  } catch {
    // A web-only process may not have a hosted worker URL configured yet.
  }
  return 5;
}

/**
 * One process-wide pool per exact database URL.
 *
 * The URL includes the login role, so hosted app_web and app_worker remain
 * isolated while every caller using the same role shares a calculable cap.
 */
export function getRegisteredPool(connectionString: string): Pool {
  const existing = state.pools.get(connectionString);
  if (existing) return existing;

  const pool = createAppPool(connectionString, {
    max: poolLimit(connectionString),
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: isHostedAuthEnabled() ? HOSTED_POOL_DEFAULTS.idleTimeoutMillis : 10_000,
    allowExitOnIdle: true,
  });
  pool.on('error', () => {
    // node-postgres requires an idle-client error listener. Never include the
    // connection string in diagnostics because it may contain credentials.
  });
  state.pools.set(connectionString, pool);
  return pool;
}

export function getPersistencePool(): Pool {
  return getRegisteredPool(getPersistenceDatabaseUrl());
}

/** HTTP generation/control-plane requests always use the app_web pool. */
export function getGenerationRequestPool(): Pool {
  return getPersistencePool();
}

export function getSystemPool(): Pool {
  return getRegisteredPool(getSystemDatabaseUrl());
}

/** Test-only lifecycle hook; production pools live for the process lifetime. */
export async function closeRegisteredPoolsForTests(): Promise<void> {
  const pools = [...state.pools.values()];
  state.pools.clear();
  await Promise.all(pools.map((pool) => pool.end().catch(() => undefined)));
}
