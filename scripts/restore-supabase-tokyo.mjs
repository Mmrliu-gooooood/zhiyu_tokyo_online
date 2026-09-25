/** Explicit target-only transactional schema restore, with private diagnostic logs. */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
const root = resolve('.scratch/supabase-tokyo-20260925'),
  ref = 'lvbtgwlsebzbtcvjwktq';
if (!process.argv.includes(`--target=${ref}`)) throw Error('Target confirmation missing');
const env = parseEnv(readFileSync(join(root, ref, 'target-hosted.env'), 'utf8'));
const u = new URL(env.HOSTED_DB_ADMIN_URL);
if (!decodeURIComponent(u.username).endsWith('.' + ref)) throw Error('Target mismatch');
const phase = process.argv[2];
const dir = join(root, phase === 'data' ? 'source-final' : 'source-preflight', 'sql');
const pgEnv = {
  ...process.env,
  PGHOST: u.hostname,
  PGPORT: u.port || '5432',
  PGUSER: decodeURIComponent(u.username),
  PGPASSWORD: decodeURIComponent(u.password),
  PGDATABASE: 'postgres',
  PGSSLMODE: 'verify-full',
  PGSSLROOTCERT: '/ca.crt',
  PGCONNECT_TIMEOUT: '30',
};
let files;
if (phase === 'schema') {
  // Supabase-owned parameter privileges cannot be granted by the postgres tenant role.
  // Custom application roles and all their grants are retained; managed grants are audited separately.
  const roles = readFileSync(join(dir, 'roles.sql'), 'utf8').replace(
    /^GRANT SET ON PARAMETER "log_min_messages" TO "supabase_realtime_admin";\r?\n/gm,
    '',
  );
  writeFileSync(join(dir, 'roles-restore.sql'), roles, { mode: 0o600 });
  files = ['roles-restore.sql', 'schema.sql', 'history-schema.sql'];
} else if (phase === 'data') {
  const localBase = [
    '--context',
    'default',
    'run',
    '--rm',
    '--mount',
    `type=bind,source=${dir},target=/backup`,
    'postgres@sha256:d74eeac9a635390a49bc21bd49fccd973de707e2a53a76ac49b552b8712ec46f',
  ];
  const local = (args) => {
    const r = spawnSync('docker', [...localBase, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 100 * 1024 * 1024,
      timeout: 120000,
    });
    if (r.status !== 0) throw Error('Local archive preparation failed: ' + r.stderr);
    return r.stdout;
  };
  const toc = local(['pg_restore', '--list', '/backup/full-source.dump']);
  const selected = toc
    .split('\n')
    .filter(
      (line) =>
        / (TABLE DATA|SEQUENCE SET) (public|app_internal|auth|supabase_migrations) /.test(line) &&
        !line.includes('TABLE DATA auth schema_migrations '),
    );
  writeFileSync(join(dir, 'data-toc.list'), selected.join('\n') + '\n', { mode: 0o600 });
  local([
    'pg_restore',
    '--data-only',
    '--use-list=/backup/data-toc.list',
    '--file=/backup/data-from-archive.sql',
    '/backup/full-source.dump',
  ]);
  const storage = local([
    'pg_restore',
    '--data-only',
    '--schema=storage',
    '--table=objects',
    '--table=buckets',
    '--file=-',
    '/backup/full-source.dump',
  ]);
  const staged = storage
    .replace(/COPY storage\.objects /g, 'COPY migration_storage_objects ')
    .replace(/COPY storage\.buckets /g, 'COPY migration_storage_buckets ');
  writeFileSync(join(dir, 'storage-staging.sql'), staged, { mode: 0o600 });
  const catalog = JSON.parse(
    readFileSync(join(root, 'source-final', 'database-inventory.json'), 'utf8'),
  ).catalog;
  const authTriggers = catalog.triggers
    .filter((t) => t.nspname === 'auth')
    .map((t) => t.definition.replace('CREATE TRIGGER ', 'CREATE OR REPLACE TRIGGER ') + ';')
    .join('\n');
  const passwords = ['DATABASE_URL_APP_WEB', 'WORKER_DATABASE_URL']
    .map((k) => {
      const c = new URL(env[k]),
        role = decodeURIComponent(c.username).split('.')[0],
        pass = decodeURIComponent(c.password);
      if (!['zhiyu_app_web', 'zhiyu_app_worker'].includes(role))
        throw Error('Unexpected login role');
      return `ALTER ROLE "${role}" PASSWORD '${pass.replaceAll("'", "''")}';`;
    })
    .join('\n');
  const wrapper = `SET session_replication_role=replica;
DO $$ BEGIN IF (SELECT count(*) FROM public.app_accounts)+(SELECT count(*) FROM auth.users)>0 THEN RAISE EXCEPTION 'Target data is not empty'; END IF; END $$;
\\i /backup/data-from-archive.sql
CREATE TEMP TABLE migration_storage_objects AS SELECT * FROM storage.objects WITH NO DATA;
CREATE TEMP TABLE migration_storage_buckets AS SELECT * FROM storage.buckets WITH NO DATA;
\\i /backup/storage-staging.sql
DO $$ BEGIN IF EXISTS(SELECT 1 FROM migration_storage_objects s FULL JOIN storage.objects t ON s.bucket_id=t.bucket_id AND s.name=t.name WHERE s.id IS NULL OR t.id IS NULL) THEN RAISE EXCEPTION 'Storage key mismatch'; END IF; END $$;
UPDATE storage.objects t SET id=s.id,owner=s.owner,owner_id=s.owner_id,created_at=s.created_at,updated_at=s.updated_at,last_accessed_at=s.last_accessed_at,user_metadata=s.user_metadata FROM migration_storage_objects s WHERE t.bucket_id=s.bucket_id AND t.name=s.name;
UPDATE storage.buckets t SET owner=s.owner,owner_id=s.owner_id,created_at=s.created_at,updated_at=s.updated_at,public=s.public,avif_autodetection=s.avif_autodetection,file_size_limit=s.file_size_limit,allowed_mime_types=s.allowed_mime_types FROM migration_storage_buckets s WHERE t.id=s.id;
${authTriggers}
${passwords}
RESET session_replication_role;
NOTIFY pgrst,'reload schema';
`;
  writeFileSync(join(dir, 'restore-final.sql'), wrapper, { mode: 0o600 });
  files = ['restore-final.sql'];
  console.log(JSON.stringify({ phase: 'prepared', archiveEntries: selected.length }));
} else throw Error('Unsupported restore phase');
const args = [
  '--context',
  'default',
  'run',
  '--rm',
  '--mount',
  `type=bind,source=${dir},target=/backup,readonly`,
  '--mount',
  `type=bind,source=${resolve(env.SUPABASE_DB_SSL_ROOT_CERT_PATH)},target=/ca.crt,readonly`,
  ...Object.keys(pgEnv)
    .filter((k) => k.startsWith('PG'))
    .flatMap((k) => ['-e', k]),
  'postgres@sha256:d74eeac9a635390a49bc21bd49fccd973de707e2a53a76ac49b552b8712ec46f',
  'psql',
  '-X',
  '--single-transaction',
  '--set',
  'ON_ERROR_STOP=on',
  ...files.flatMap((f) => ['--file', '/backup/' + f]),
];
const child = spawn('docker', args, {
  env: pgEnv,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (b) => (log += b));
child.stderr.on('data', (b) => (log += b));
const code = await new Promise((accept, reject) => {
  child.on('error', reject);
  child.on('exit', accept);
});
writeFileSync(join(root, ref, `restore-${phase}.log`), log, { mode: 0o600 });
console.log(JSON.stringify({ phase, code, log: join(root, ref, `restore-${phase}.log`) }));
if (code !== 0) {
  console.error(
    log
      .split('\n')
      .filter((x) => /ERROR|FATAL/.test(x))
      .join('\n'),
  );
  process.exitCode = 1;
}
