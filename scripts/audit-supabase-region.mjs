/** Read-only source audit and local Storage backup. No remote writes. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseEnv } from 'node:util';
import pg from 'pg';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';

const args = process.argv.slice(2);
const envFile = resolve(args[0] || '.env.hosted.local');
const out = resolve(args[1] || '.scratch/supabase-tokyo-20260925/source-preflight');
const backupObjects = args.includes('--backup-objects');
const env = {
  ...parseEnv(readFileSync(resolve('.env.local'), 'utf8')),
  ...parseEnv(readFileSync(envFile, 'utf8')),
};
const expectedRef = args.find((x) => x.startsWith('--expect-ref='))?.split('=')[1];
if (!expectedRef) throw new Error('Explicit --expect-ref is required');
if (new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname !== `${expectedRef}.supabase.co`)
  throw new Error('Project mismatch');
if (!out.startsWith(resolve('.scratch') + '\\') && !out.startsWith(resolve('.scratch') + '/'))
  throw new Error('Output must be under .scratch');
mkdirSync(out, { recursive: true });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const save = (name, value) =>
  writeFileSync(join(out, name), JSON.stringify(value, null, 2), { mode: 0o600 });
const ident = (s) => '"' + s.replaceAll('"', '""') + '"';
const dbUrl = new URL(env.HOSTED_DB_ADMIN_URL);
for (const p of ['sslmode', 'sslrootcert', 'uselibpqcompat']) dbUrl.searchParams.delete(p);
const db = new pg.Client({
  connectionString: dbUrl.href,
  ssl: { ca: readFileSync(env.SUPABASE_DB_SSL_ROOT_CERT_PATH, 'utf8'), rejectUnauthorized: true },
  connectionTimeoutMillis: 30000,
  statement_timeout: 60000,
});
const s3 = new S3Client({
  endpoint: env.ASSET_S3_ENDPOINT,
  region: env.ASSET_S3_REGION,
  forcePathStyle: true,
  credentials: {
    accessKeyId: env.ASSET_S3_ACCESS_KEY_ID,
    secretAccessKey: env.ASSET_S3_SECRET_ACCESS_KEY,
  },
  maxAttempts: 3,
});
try {
  await db.connect();
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const q = async (sql) => (await db.query(sql)).rows;
  const tables = await q(
    "select schemaname,tablename from pg_tables where schemaname not like 'pg_%' and schemaname <> 'information_schema' order by 1,2",
  );
  const result = {
    projectRef: expectedRef,
    capturedAt: new Date().toISOString(),
    livePreflight: true,
    tables: [],
    catalog: {},
  };
  for (const table of tables) {
    const full = `${ident(table.schemaname)}.${ident(table.tablename)}`;
    if (args.includes('--server-hash')) {
      // Same sorted SHA-256 construction as the client path, without exporting row contents.
      const { rows } = await db.query(
        `select count(*)::int as count, encode(extensions.digest(coalesce(string_agg(row_hash, E'\\n' order by row_hash COLLATE "C"),''),'sha256'),'hex') as sha256 from (select encode(extensions.digest(to_jsonb(t)::text,'sha256'),'hex') as row_hash from ${full} t) hashed`,
      );
      result.tables.push({ schema: table.schemaname, table: table.tablename, ...rows[0] });
      continue;
    }
    // Hash PostgreSQL's stable JSONB serialization to avoid JS timestamp/bytea conversion loss.
    const { rows } = await db.query(`select to_jsonb(t)::text as canonical_row from ${full} t`);
    const rowHashes = rows.map((r) => hash(r.canonical_row)).sort();
    result.tables.push({
      schema: table.schemaname,
      table: table.tablename,
      count: rows.length,
      sha256: hash(rowHashes.join('\n')),
    });
  }
  const catalogQueries = {
    columnPrivileges:
      "select n.nspname,c.relname,a.attname,a.attacl from pg_attribute a join pg_class c on a.attrelid=c.oid join pg_namespace n on c.relnamespace=n.oid where a.attnum>0 and not a.attisdropped and a.attacl is not null and n.nspname in ('public','app_internal','auth','storage') order by 1,2,3",
    schemas:
      "select nspname,pg_get_userbyid(nspowner) as owner,nspacl from pg_namespace where nspname !~ '^pg_' and nspname <> 'information_schema' order by 1",
    tables:
      "select n.nspname,c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) as owner,c.relacl from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','app_internal','auth','storage') and c.relkind in ('r','p','v','m','S') order by 1,2",
    columns:
      "select table_schema,table_name,column_name,ordinal_position,column_default,is_nullable,data_type,udt_name,is_identity,identity_generation,is_generated,generation_expression from information_schema.columns where table_schema in ('public','app_internal','auth','storage') order by 1,2,4",
    constraints:
      "select n.nspname,c.relname,k.conname,pg_get_constraintdef(k.oid) as definition from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','app_internal','auth','storage') order by 1,2,3",
    indexes:
      "select schemaname,tablename,indexname,indexdef from pg_indexes where schemaname in ('public','app_internal','auth','storage') order by 1,2,3",
    functions:
      "select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) as args,pg_get_functiondef(p.oid) as definition,pg_get_userbyid(p.proowner) as owner,p.proacl from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','app_internal') and p.prokind in ('f','p') order by 1,2,3",
    triggers:
      "select n.nspname,c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) as definition from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where not t.tgisinternal and n.nspname in ('public','app_internal','auth','storage') order by 1,2,3",
    eventTriggers:
      'select e.evtname,e.evtevent,e.evtenabled,e.evttags,p.proname,n.nspname from pg_event_trigger e join pg_proc p on p.oid=e.evtfoid join pg_namespace n on n.oid=p.pronamespace order by 1',
    policies:
      "select * from pg_policies where schemaname in ('public','app_internal','auth','storage','realtime') order by schemaname,tablename,policyname",
    roles:
      "select rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolconnlimit,rolvaliduntil,rolbypassrls,rolconfig from pg_roles where rolname not like 'pg_%' order by 1",
    memberships:
      'select r.rolname as role,m.rolname as member,a.admin_option,a.inherit_option,a.set_option from pg_auth_members a join pg_roles r on r.oid=a.roleid join pg_roles m on m.oid=a.member order by 1,2',
    defaultPrivileges:
      'select pg_get_userbyid(d.defaclrole) as role,n.nspname,d.defaclobjtype,d.defaclacl from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace order by 1,2,3',
    sequences:
      "select * from pg_sequences where schemaname not like 'pg_%' order by schemaname,sequencename",
    publications: 'select * from pg_publication order by pubname',
    publicationTables: 'select * from pg_publication_tables order by pubname,schemaname,tablename',
    extensions:
      'select e.extname,e.extversion,n.nspname from pg_extension e join pg_namespace n on n.oid=e.extnamespace order by 1',
    settings:
      "select name,setting,unit,source from pg_settings where source not in ('default','override') order by 1",
    roleDbSettings:
      "select coalesce(r.rolname,'ALL') as role,coalesce(d.datname,'ALL') as database,s.setconfig from pg_db_role_setting s left join pg_roles r on r.oid=s.setrole left join pg_database d on d.oid=s.setdatabase order by 1,2",
  };
  for (const [name, sql] of Object.entries(catalogQueries)) result.catalog[name] = await q(sql);
  const buckets = await q('select * from storage.buckets order by id');
  const objects = await q('select * from storage.objects order by bucket_id,name');
  save('database-inventory.json', result);
  save('storage-buckets.json', buckets);
  save('storage-database-objects.json', objects);
  save(
    'encryption-key-fingerprints.json',
    Object.fromEntries(
      [
        'MEDIA_CONFIG_ENCRYPTION_KEY',
        'GENERATION_MODEL_ENCRYPTION_KEY',
        'PRO_MODEL_ENCRYPTION_KEY',
        'GENERATION_SESSION_SECRET',
      ].map((k) => [k, env[k] ? hash(env[k]) : null]),
    ),
  );
  await db.query('COMMIT');
  console.log(
    JSON.stringify({
      phase: 'database-audit',
      tables: result.tables.length,
      businessTables: result.tables.filter((t) => ['public', 'app_internal'].includes(t.schema))
        .length,
      rows: result.tables.reduce((a, t) => a + t.count, 0),
      output: out,
    }),
  );
  const manifest = [];
  for (const bucket of buckets) {
    let ContinuationToken;
    do {
      const page = await s3.send(
        new ListObjectsV2Command({ Bucket: bucket.id, ContinuationToken }),
      );
      for (const object of page.Contents || [])
        manifest.push({ bucket: bucket.id, key: object.Key, size: object.Size, etag: object.ETag });
      ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      if (page.IsTruncated && !ContinuationToken)
        throw new Error('Missing Storage pagination token');
    } while (ContinuationToken);
  }
  save('storage-list.json', manifest);
  const metadataKeys = new Set(objects.map((x) => JSON.stringify([x.bucket_id, x.name])));
  const s3Keys = new Set(manifest.map((x) => JSON.stringify([x.bucket, x.key])));
  const mismatch = {
    metadataOnly: [...metadataKeys].filter((x) => !s3Keys.has(x)),
    storageOnly: [...s3Keys].filter((x) => !metadataKeys.has(x)),
  };
  save('storage-list-diff.json', mismatch);
  if (mismatch.metadataOnly.length || mismatch.storageOnly.length)
    throw new Error('Storage metadata/object listing mismatch');
  if (backupObjects) {
    const bytesDir = join(out, 'objects');
    mkdirSync(bytesDir, { recursive: true });
    let index = 0,
      completed = 0;
    const download = async () => {
      for (;;) {
        const item = manifest[index++];
        if (!item) return;
        const path = join(bytesDir, hash(JSON.stringify([item.bucket, item.key])) + '.bin');
        let content;
        const response = await s3.send(
          new GetObjectCommand({ Bucket: item.bucket, Key: item.key }),
        );
        content = Buffer.from(await response.Body.transformToByteArray());
        if (content.length !== item.size) throw new Error('Object size mismatch');
        item.sha256 = hash(content);
        item.localFile = path;
        item.contentType = response.ContentType;
        item.cacheControl = response.CacheControl;
        item.metadata = response.Metadata;
        if (!existsSync(path) || hash(readFileSync(path)) !== item.sha256)
          writeFileSync(path, content, { mode: 0o600 });
        completed++;
        if (completed % 100 === 0) {
          save('storage-backup-progress.json', manifest);
          console.log(
            JSON.stringify({ phase: 'storage-backup', completed, total: manifest.length }),
          );
        }
      }
    };
    await Promise.all(Array.from({ length: 4 }, download));
    save('storage-backup-manifest.json', manifest);
    for (const f of [envFile, resolve('.env.local')])
      copyFileSync(f, join(out, f === envFile ? 'source-hosted.env' : 'source-base.env'));
  }
  console.log(
    JSON.stringify({
      phase: 'complete',
      buckets: buckets.length,
      objects: manifest.length,
      bytes: manifest.reduce((a, x) => a + x.size, 0),
      backedUp: backupObjects,
      listingMatched: true,
    }),
  );
} catch (error) {
  // Do not print connection strings, credentials, user records or object contents.
  console.error(
    JSON.stringify({
      phase: 'failed',
      code: error.code || error.name,
      message: String(error.message).replace(/postgres(?:ql)?:\/\/\S+/g, '[database-url]'),
    }),
  );
  process.exitCode = 1;
} finally {
  await db.end().catch(() => {});
  s3.destroy();
}
