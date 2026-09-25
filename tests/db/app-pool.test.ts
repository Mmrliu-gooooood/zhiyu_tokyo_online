import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  appPostgresConnectionConfig,
  connectionStringForExplicitHostedSsl,
  hostedPoolSsl,
  HOSTED_POOL_DEFAULTS,
} from '@/lib/db/app-pool';
import { isTransientRegistryError } from '@/lib/auth/session';

let fixtureDir: string;
let caPath: string;
const TEST_CA = '-----BEGIN CERTIFICATE-----\nunit-test-ca\n-----END CERTIFICATE-----\n';

beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'openmaic-db-ca-'));
  caPath = join(fixtureDir, 'supabase-ca.crt');
  writeFileSync(caPath, TEST_CA);
});

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe('hostedPoolSsl', () => {
  it('enables certificate verification for the session pooler with the supplied CA', () => {
    expect(
      hostedPoolSsl(
        'postgresql://zhiyu_app_web.example@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres',
        caPath,
      ),
    ).toEqual({ ca: TEST_CA, rejectUnauthorized: true });
  });

  it('leaves the classroom localhost URL unchanged', () => {
    expect(hostedPoolSsl('postgresql://openmaic:dev@127.0.0.1:5432/openmaic')).toBeUndefined();
  });

  it('fails closed when a hosted connection has no readable PEM CA', () => {
    const url = 'postgresql://listener@db.lzomhnjyymalupgvcato.supabase.co:5432/postgres';
    expect(() => hostedPoolSsl(url, '')).toThrow(/SUPABASE_DB_SSL_ROOT_CERT_PATH/);
    expect(() => hostedPoolSsl(url, join(fixtureDir, 'missing.crt'))).toThrow(
      /Unable to read SUPABASE_DB_SSL_ROOT_CERT_PATH/,
    );
    const invalid = join(fixtureDir, 'invalid.crt');
    writeFileSync(invalid, 'not a certificate');
    expect(() => hostedPoolSsl(url, invalid)).toThrow(/PEM certificate/);
  });

  it('caps hosted pooler connections and waits for a checkout', () => {
    expect(HOSTED_POOL_DEFAULTS.max).toBe(5);
    expect(HOSTED_POOL_DEFAULTS.connectionTimeoutMillis).toBe(10_000);
    expect(HOSTED_POOL_DEFAULTS.idleTimeoutMillis).toBe(60_000);
  });

  it('reuses verified TLS settings for a dedicated hosted client', () => {
    expect(
      appPostgresConnectionConfig(
        'postgresql://listener@db.lzomhnjyymalupgvcato.supabase.co:5432/postgres?sslmode=require&uselibpqcompat=true&application_name=readiness',
        caPath,
      ),
    ).toEqual({
      connectionString:
        'postgresql://listener@db.lzomhnjyymalupgvcato.supabase.co:5432/postgres?application_name=readiness',
      ssl: { ca: TEST_CA, rejectUnauthorized: true },
    });
  });

  it('removes only pg SSL query settings that would override the explicit CA', () => {
    expect(
      connectionStringForExplicitHostedSsl(
        'postgresql://u:p@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=verify-full&sslrootcert=old.pem&application_name=web',
      ),
    ).toBe(
      'postgresql://u:p@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?application_name=web',
    );
  });

  it('recognizes a DNS trailing dot and still strips an insecure SSL mode', () => {
    expect(
      appPostgresConnectionConfig(
        'postgresql://u:p@aws-0-ap-southeast-1.pooler.supabase.com.:5432/postgres?sslmode=disable',
        caPath,
      ),
    ).toEqual({
      connectionString: 'postgresql://u:p@aws-0-ap-southeast-1.pooler.supabase.com.:5432/postgres',
      ssl: { ca: TEST_CA, rejectUnauthorized: true },
    });
  });

  it('keeps the explicit CA after node-postgres parses the sanitized URL', async () => {
    const config = appPostgresConnectionConfig(
      'postgresql://u:p@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=require&uselibpqcompat=true',
      caPath,
    );
    const pool = new Pool(config);
    expect(pool.options.ssl).toEqual({ ca: TEST_CA, rejectUnauthorized: true });
    await pool.end();
  });
});

describe('isTransientRegistryError', () => {
  it('retries pooler timeouts and dropped connections', () => {
    expect(isTransientRegistryError({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isTransientRegistryError({ code: '53300' })).toBe(true);
    expect(isTransientRegistryError(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(isTransientRegistryError({ code: '42501' })).toBe(false);
  });
});
