import { readFileSync } from 'node:fs';

import { Pool, type PoolConfig } from 'pg';

/** Hosted database connections must encrypt and verify the server identity. */
const HOSTED_DB_HOST = /(^|\.)supabase\.co$|(^|\.)pooler\.supabase\.com$/i;
const SSL_QUERY_PARAMETERS = [
  'sslmode',
  'sslcert',
  'sslkey',
  'sslrootcert',
  'sslpassword',
  'uselibpqcompat',
] as const;

export const HOSTED_POOL_DEFAULTS: PoolConfig = {
  max: 5,
  connectionTimeoutMillis: 10_000,
  // Hosted TLS/SASL handshakes can take several seconds. Retain idle sessions
  // across ordinary UI pauses instead of repeating that cost on every action.
  // This does not extend checkout deadlines or worker lease TTLs.
  idleTimeoutMillis: 60_000,
  allowExitOnIdle: true,
};

function hostedDatabaseUrl(connectionString: string): URL | undefined {
  try {
    const parsed = new URL(connectionString);
    const hostname = parsed.hostname.replace(/\.$/, '');
    return HOSTED_DB_HOST.test(hostname) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * node-postgres lets SSL query parameters replace the explicit `ssl` object.
 * Hosted connections therefore remove only those parameters and use the
 * verified CA object below as the single TLS source of truth.
 */
export function connectionStringForExplicitHostedSsl(connectionString: string): string {
  const parsed = hostedDatabaseUrl(connectionString);
  if (!parsed) return connectionString;
  for (const name of SSL_QUERY_PARAMETERS) parsed.searchParams.delete(name);
  return parsed.toString();
}

export function hostedPoolSsl(
  connectionString: string,
  rootCertPath = process.env.SUPABASE_DB_SSL_ROOT_CERT_PATH?.trim(),
): { ca: string; rejectUnauthorized: true } | undefined {
  if (!hostedDatabaseUrl(connectionString)) return undefined;
  if (!rootCertPath) {
    throw new Error('Hosted Supabase database connections require SUPABASE_DB_SSL_ROOT_CERT_PATH');
  }
  let ca: string;
  try {
    ca = readFileSync(rootCertPath, 'utf8');
  } catch {
    throw new Error('Unable to read SUPABASE_DB_SSL_ROOT_CERT_PATH');
  }
  if (!ca.includes('-----BEGIN CERTIFICATE-----') || !ca.includes('-----END CERTIFICATE-----')) {
    throw new Error('SUPABASE_DB_SSL_ROOT_CERT_PATH must contain a PEM certificate');
  }
  return { ca, rejectUnauthorized: true };
}

/** Shared connection settings for Pool and dedicated Client users. */
export function appPostgresConnectionConfig(
  connectionString: string,
  rootCertPath?: string,
): PoolConfig {
  const ssl = hostedPoolSsl(connectionString, rootCertPath);
  return {
    connectionString: ssl
      ? connectionStringForExplicitHostedSsl(connectionString)
      : connectionString,
    ...(ssl ? { ssl } : {}),
  };
}

export function createAppPool(connectionString: string, config: PoolConfig = {}): Pool {
  const base = appPostgresConnectionConfig(connectionString);
  return new Pool({
    ...base,
    ...(base.ssl ? HOSTED_POOL_DEFAULTS : {}),
    ...config,
    ...(base.ssl ? { ssl: base.ssl } : {}),
  });
}
