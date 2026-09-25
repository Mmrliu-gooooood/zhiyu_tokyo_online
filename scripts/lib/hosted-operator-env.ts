/**
 * Load gitignored .env.hosted.local into process.env without overriding
 * values already set. Never prints values.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';

import { appPostgresConnectionConfig } from '../../lib/db/app-pool';

// Some operator entry points are bundled into a temporary directory. Prefer
// the explicit launch directory when it is the repository root.
const ROOT = existsSync(resolve(process.cwd(), 'package.json'))
  ? resolve(process.cwd())
  : resolve(__dirname, '..', '..');
const HOSTED_REF = 'lvbtgwlsebzbtcvjwktq';
const HOSTED_DIRECT_HOST = `db.${HOSTED_REF}.supabase.co`;
const HOSTED_POOLER_HOST = 'aws-0-ap-northeast-1.pooler.supabase.com';
const WEB_ROLE = 'zhiyu_app_web';
const WORKER_ROLE = 'zhiyu_app_worker';

export function loadHostedOperatorEnv(): void {
  const path = resolve(ROOT, '.env.hosted.local');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    const key = match[1]!;
    const raw = match[2] ?? '';
    const quoted =
      raw.length >= 2 &&
      ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")));
    const value = quoted ? raw.slice(1, -1) : raw;
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function isHostedDbHost(hostname: string): boolean {
  return hostname === HOSTED_DIRECT_HOST || hostname === HOSTED_POOLER_HOST;
}

export function hostedRoleFromUsername(username: string): string | undefined {
  const decoded = decodeURIComponent(username);
  if (decoded === WEB_ROLE || decoded === `${WEB_ROLE}.${HOSTED_REF}`) return WEB_ROLE;
  if (decoded === WORKER_ROLE || decoded === `${WORKER_ROLE}.${HOSTED_REF}`) return WORKER_ROLE;
  if (decoded === 'postgres' || decoded === `postgres.${HOSTED_REF}`) return 'postgres';
  return undefined;
}

function hostedUrlIfAllowed(url: string | undefined, expectedRole: string): string | undefined {
  const trimmed = url?.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (!isHostedDbHost(parsed.hostname)) return undefined;
    if (hostedRoleFromUsername(parsed.username) !== expectedRole) return undefined;
    return trimmed;
  } catch {
    return undefined;
  }
}

/** LOGIN role zhiyu_app_web. Prefers DATABASE_URL_APP_WEB so live DATABASE_URL is never used. */
export function hostedAppWebDatabaseUrl(): string | undefined {
  return (
    hostedUrlIfAllowed(process.env.DATABASE_URL_APP_WEB, WEB_ROLE) ||
    hostedUrlIfAllowed(process.env.DATABASE_URL, WEB_ROLE)
  );
}

/** @deprecated Use hostedAppWebDatabaseUrl — kept for provision/remove scripts. */
export function hostedDatabaseUrl(): string | undefined {
  return hostedAppWebDatabaseUrl();
}

export function hostedWorkerDatabaseUrl(): string | undefined {
  return hostedUrlIfAllowed(process.env.WORKER_DATABASE_URL, WORKER_ROLE);
}

/** Privileged operator URL used only by explicit migration/lifecycle scripts. */
export function hostedAdminDatabaseUrl(): string | undefined {
  return hostedUrlIfAllowed(process.env.HOSTED_DB_ADMIN_URL, 'postgres');
}

export const HOSTED_PROJECT_REF = HOSTED_REF;
export const HOSTED_DIRECT_DB_HOST = HOSTED_DIRECT_HOST;
export const HOSTED_SESSION_POOLER_HOST = HOSTED_POOLER_HOST;
export const HOSTED_WEB_ROLE = WEB_ROLE;
export const HOSTED_WORKER_ROLE = WORKER_ROLE;

/** Verify the hosted database certificate and hostname. Never logs URLs. */
export function withHostedSsl(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('sslmode', 'verify-full');
  parsed.searchParams.set('uselibpqcompat', 'true');
  return parsed.toString();
}

export function hostedPgPool(connectionString: string, max = 1): Pool {
  if (!Number.isSafeInteger(max) || max < 1 || max > 16) {
    throw new Error('hosted operator pool max must be an integer from 1 to 16');
  }
  return new Pool({
    ...appPostgresConnectionConfig(withHostedSsl(connectionString)),
    max,
    // Operator migrations can briefly queue behind Supabase's session-pooler
    // clients. A longer acquisition window avoids abandoning an otherwise
    // healthy resumable batch while still failing closed on a dead endpoint.
    connectionTimeoutMillis: max === 1 ? 15000 : 60000,
  });
}
