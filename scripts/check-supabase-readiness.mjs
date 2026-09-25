/**
 * Deployment readiness probe for docker-compose.supabase.yml.
 *
 * It deliberately reports only booleans, versions and counts. Connection
 * strings and S3 credentials are never included in output or error messages.
 */
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const { Pool } = pg;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required deployment setting: ${name}`);
  return value;
}

function integer(name, fallback, min, max) {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`Invalid deployment setting: ${name}`);
  }
  return value;
}

function boolean(name, fallback) {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  throw new Error(`Invalid deployment setting: ${name}`);
}

function hostedSsl(connectionString) {
  try {
    const parsed = new URL(connectionString);
    const hostname = parsed.hostname.replace(/\.$/, '');
    if (!/(^|\.)supabase\.co$|(^|\.)pooler\.supabase\.com$/i.test(hostname)) {
      throw new Error('WORKER_DATABASE_URL must use a Supabase database host');
    }
    for (const name of [
      'sslmode',
      'sslcert',
      'sslkey',
      'sslrootcert',
      'sslpassword',
      'uselibpqcompat',
    ]) {
      parsed.searchParams.delete(name);
    }
    let ca;
    try {
      ca = readFileSync(required('SUPABASE_DB_SSL_ROOT_CERT_PATH'), 'utf8');
    } catch {
      throw new Error('Unable to read SUPABASE_DB_SSL_ROOT_CERT_PATH');
    }
    if (!ca.includes('-----BEGIN CERTIFICATE-----') || !ca.includes('-----END CERTIFICATE-----')) {
      throw new Error('SUPABASE_DB_SSL_ROOT_CERT_PATH must contain a PEM certificate');
    }
    return {
      connectionString: parsed.toString(),
      ssl: { ca, rejectUnauthorized: true },
    };
  } catch {
    throw new Error('Invalid hosted database TLS configuration');
  }
}

async function checkDatabase() {
  const connectionString = required('WORKER_DATABASE_URL');
  const hosted = hostedSsl(connectionString);
  const pool = new Pool({
    connectionString: hosted.connectionString,
    ssl: hosted.ssl,
    max: 1,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 2_000,
    allowExitOnIdle: true,
  });
  try {
    const requiredAccounts = integer('ACCOUNTS_SCHEMA_REQUIRED', 19, 1, 10_000);
    const requiredGeneration = integer('GENERATION_SCHEMA_REQUIRED', 4, 1, 10_000);
    const expectedWorkers = integer('GENERATION_EXPECTED_WORKERS', 2, 1, 32);
    const pipelineVersion = required('GENERATION_PIPELINE_REQUIRED');
    const result = await pool.query(
      'SELECT * FROM app_internal.deployment_readiness($1::jsonb)',
      [JSON.stringify([pipelineVersion])],
    );
    const row = result.rows[0] ?? {};
    const accountsVersion = Number(row.accounts_version ?? 0);
    const generationVersion = Number(row.generation_version ?? 0);
    const liveWorkers = Number(row.live_workers ?? 0);
    return {
      database: true,
      accountsSchema: accountsVersion >= requiredAccounts,
      accountsVersion,
      generationSchema: generationVersion >= requiredGeneration,
      generationVersion,
      workerHeartbeats: liveWorkers >= expectedWorkers,
      liveWorkers,
      expectedWorkers,
    };
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function checkStorage() {
  if (required('ASSET_BYTE_BACKEND') !== 's3') {
    throw new Error('ASSET_BYTE_BACKEND must be s3 in the Supabase deployment');
  }
  if (required('MATERIAL_BYTE_BACKEND') !== 's3') {
    throw new Error('MATERIAL_BYTE_BACKEND must be s3 in the Supabase deployment');
  }
  const endpoint = new URL(required('ASSET_S3_ENDPOINT'));
  if (!/^https:$/.test(endpoint.protocol)) {
    throw new Error('ASSET_S3_ENDPOINT must use HTTPS');
  }
  const client = new S3Client({
    endpoint: endpoint.toString().replace(/\/$/, ''),
    region: required('ASSET_S3_REGION'),
    forcePathStyle: boolean('ASSET_S3_FORCE_PATH_STYLE', true),
    credentials: {
      accessKeyId: required('ASSET_S3_ACCESS_KEY_ID'),
      secretAccessKey: required('ASSET_S3_SECRET_ACCESS_KEY'),
    },
  });
  const buckets = [
    ...new Set([
      required('ASSET_S3_BUCKET'),
      required('MATERIAL_S3_BUCKET'),
      required('CLASSROOM_S3_BUCKET'),
    ]),
  ];
  await Promise.all(buckets.map((Bucket) => client.send(new HeadBucketCommand({ Bucket }))));
  client.destroy();
  return {
    assetBackend: true,
    materialBackend: true,
    classroomBackend: true,
    privateBucketsReachable: buckets.length,
  };
}

async function main() {
  const [database, storage] = await Promise.all([checkDatabase(), checkStorage()]);
  const ready =
    database.database &&
    database.accountsSchema &&
    database.generationSchema &&
    database.workerHeartbeats &&
    storage.assetBackend &&
    storage.materialBackend &&
    storage.classroomBackend;
  process.stdout.write(`${JSON.stringify({ ready, ...database, ...storage })}\n`);
  if (!ready) process.exitCode = 1;
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : 'unknown readiness failure';
  process.stderr.write(`Supabase deployment is not ready: ${message}\n`);
  process.exitCode = 1;
});
