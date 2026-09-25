/** Hold table SHARE locks during final migration; reads remain allowed, writes wait. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { resolve, join } from 'node:path';
import pg from 'pg';
const ref = 'lzomhnjyymalupgvcato',
  root = resolve('.scratch/supabase-tokyo-20260925');
if (!process.argv.includes(`--source=${ref}`)) throw Error('Explicit source required');
const e = parseEnv(readFileSync('.env.hosted.local', 'utf8')),
  u = new URL(e.HOSTED_DB_ADMIN_URL);
if (!decodeURIComponent(u.username).endsWith('.' + ref)) throw Error('Source mismatch');
for (const k of ['sslmode', 'sslrootcert', 'uselibpqcompat']) u.searchParams.delete(k);
const db = new pg.Client({
  connectionString: u.href,
  ssl: { ca: readFileSync(e.SUPABASE_DB_SSL_ROOT_CERT_PATH, 'utf8'), rejectUnauthorized: true },
  connectionTimeoutMillis: 30000,
  application_name: 'tokyo_migration_write_freeze',
});
const ident = (x) => '"' + x.replaceAll('"', '""') + '"';
await db.connect();
const tables = (
  await db.query(
    "select schemaname,tablename from pg_tables where (schemaname in ('public','auth','supabase_migrations') or (schemaname='storage' and tablename in ('buckets','objects','s3_multipart_uploads','s3_multipart_uploads_parts'))) and not (schemaname='auth' and tablename='schema_migrations') order by 1,2",
  )
).rows;
await db.query(
  "BEGIN; SET LOCAL lock_timeout='30s'; SET LOCAL idle_in_transaction_session_timeout=0; SET LOCAL statement_timeout=0;",
);
await db.query(
  'LOCK TABLE ' +
    tables.map((t) => ident(t.schemaname) + '.' + ident(t.tablename)).join(',') +
    ' IN SHARE MODE',
);
const frozen = {
  project: ref,
  frozenAt: new Date().toISOString(),
  tables: tables.length,
  pid: db.processID,
};
writeFileSync(join(root, 'source-freeze.json'), JSON.stringify(frozen, null, 2), { mode: 0o600 });
console.log(JSON.stringify(frozen));
try {
  while (!existsSync(join(root, 'release-source-freeze'))) {
    await new Promise((r) => setTimeout(r, 10000));
    await db.query('SELECT 1');
  }
  await db.query('ROLLBACK');
  console.log('Source write freeze released');
} finally {
  await db.end();
}
