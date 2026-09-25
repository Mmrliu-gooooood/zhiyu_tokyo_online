import { isHostedAuthEnabled } from '@/lib/auth/mode';

/**
 * System (worker / queue / collector / LISTEN) database URL.
 *
 * Legacy (`AUTH_MODE` unset): `DATABASE_URL`, same as today's Docker stack.
 * Hosted: `WORKER_DATABASE_URL` is required so fair job claim and GC are not
 * run as `app_web` under RLS. Persistence HTTP still uses `DATABASE_URL`.
 */
export function getSystemDatabaseUrl(): string {
  if (isHostedAuthEnabled()) {
    const worker = process.env.WORKER_DATABASE_URL?.trim();
    if (!worker) {
      throw new Error('Hosted auth requires WORKER_DATABASE_URL');
    }
    return worker;
  }
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error('DATABASE_URL is required');
  }
  return url;
}

export function trySystemDatabaseUrl(): string | undefined {
  try {
    return getSystemDatabaseUrl();
  } catch {
    return undefined;
  }
}

/** LISTEN needs session/direct semantics; fall back to the system URL. */
export function getListenDatabaseUrl(): string {
  const listen = process.env.DATABASE_LISTEN_URL?.trim();
  if (listen) return listen;
  return getSystemDatabaseUrl();
}

/**
 * Web event-stream LISTEN URL. Hosted Web must use its own app_web session
 * login; it must never inherit the worker LISTEN credential. Legacy installs
 * retain the historical shared connection fallback.
 */
export function getWebListenDatabaseUrl(): string {
  const listen = process.env.DATABASE_LISTEN_URL_APP_WEB?.trim();
  if (listen) return listen;
  if (isHostedAuthEnabled()) {
    throw new Error('Hosted auth requires DATABASE_LISTEN_URL_APP_WEB');
  }
  return getListenDatabaseUrl();
}

/**
 * Web persistence / request-bound stores. Always `DATABASE_URL` (`app_web`
 * when hosted). Never the worker URL.
 */
export function getPersistenceDatabaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error('DATABASE_URL is required');
  }
  return url;
}

/**
 * In-process Pro agent stores (sessions, materials, skills, model
 * connections, generation/media/search snapshots used by the runner).
 *
 * Hosted: `WORKER_DATABASE_URL` so claim / fair-turn / lease can see every
 * owner. Legacy: the shared `DATABASE_URL` pool — do not require a second URL.
 */
export function getAgentRuntimeDatabaseUrl(): string {
  return getSystemDatabaseUrl();
}

export function tryAgentRuntimeDatabaseUrl(): string | undefined {
  return trySystemDatabaseUrl();
}
