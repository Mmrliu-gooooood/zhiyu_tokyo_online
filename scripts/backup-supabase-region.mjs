/** Local logical backup using PostgreSQL 17 and Supabase CLI's documented filters. */
import { spawnSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseEnv } from 'node:util';
import { createHash } from 'node:crypto';

const expectedRef = process.argv.find((x) => x.startsWith('--expect-ref='))?.split('=')[1];
if (!expectedRef) throw new Error('Explicit --expect-ref required');
const env = parseEnv(readFileSync('.env.hosted.local', 'utf8'));
if (new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname !== `${expectedRef}.supabase.co`)
  throw new Error('Project mismatch');
const out = resolve(
  process.argv.find((x) => x.startsWith('--output='))?.slice(9) ||
    '.scratch/supabase-tokyo-20260925/source-preflight/sql',
);
if (!out.startsWith(resolve('.scratch') + '\\')) throw Error('Backup output must remain private');
mkdirSync(out, { recursive: true });
const uri = new URL(env.HOSTED_DB_ADMIN_URL);
const pgEnv = {
  ...process.env,
  DOCKER_CONTEXT: 'default',
  PGHOST: uri.hostname,
  PGPORT: uri.port || '5432',
  PGUSER: decodeURIComponent(uri.username),
  PGPASSWORD: decodeURIComponent(uri.password),
  PGDATABASE: uri.pathname.slice(1),
  PGSSLMODE: 'verify-full',
  PGSSLROOTCERT: '/source-ca.crt',
  PGCONNECT_TIMEOUT: '30',
};
const ca = resolve(env.SUPABASE_DB_SSL_ROOT_CERT_PATH);
const image = 'postgres@sha256:d74eeac9a635390a49bc21bd49fccd973de707e2a53a76ac49b552b8712ec46f';
const base = [
  '--context',
  'default',
  'run',
  '--rm',
  '--mount',
  `type=bind,source=${out},target=/backup`,
  '--mount',
  `type=bind,source=${ca},target=/source-ca.crt,readonly`,
  ...[
    'PGHOST',
    'PGPORT',
    'PGUSER',
    'PGPASSWORD',
    'PGDATABASE',
    'PGSSLMODE',
    'PGSSLROOTCERT',
    'PGCONNECT_TIMEOUT',
  ].flatMap((x) => ['-e', x]),
  image,
];
const redact = (x) =>
  x
    .replaceAll(pgEnv.PGPASSWORD, '[redacted]')
    .replace(/postgres(?:ql)?:\/\/\S+/g, '[database-url]');
async function docker(args) {
  await new Promise((accept, reject) => {
    const child = spawn('docker', [...base, ...args], {
      env: pgEnv,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    child.stdout.on('data', (x) => {
      err += x.toString();
    });
    child.stderr.on('data', (x) => {
      err += x.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? accept()
        : reject(new Error(`Docker backup failed (${code}): ${redact(err).slice(-3000)}`)),
    );
  });
}
try {
  await docker(['pg_dump', '--format=custom', '--file=/backup/full-source.dump']);
  console.log(JSON.stringify({ phase: 'full-backup-complete' }));
  if (process.argv.includes('--full-only')) {
    const b = readFileSync(join(out, 'full-source.dump'));
    writeFileSync(
      join(out, 'backup-manifest.json'),
      JSON.stringify(
        {
          projectRef: expectedRef,
          capturedAt: new Date().toISOString(),
          files: [
            {
              name: 'full-source.dump',
              bytes: b.length,
              sha256: createHash('sha256').update(b).digest('hex'),
            },
          ],
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    process.exit(0);
  }
  const modes = [
    ['roles', ['--role-only']],
    ['schema', []],
    [
      'data',
      [
        '--data-only',
        '--use-copy',
        '-x',
        'storage.buckets_vectors',
        '-x',
        'storage.vector_indexes',
      ],
    ],
    ['history-schema', ['--schema', 'supabase_migrations']],
    ['history-data', ['--schema', 'supabase_migrations', '--data-only', '--use-copy']],
  ];
  for (const [name, flags] of modes) {
    // Only a dummy URL is ever supplied to CLI dry-run; real credentials stay in child env.
    const command =
      'npx --yes supabase@2.117.0 db dump --db-url postgresql://postgres:placeholder@localhost:5432/postgres --dry-run ' +
      flags.join(' ');
    const cli = spawnSync('cmd.exe', ['/d', '/s', '/c', command], {
      env: pgEnv,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120000,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (cli.status !== 0)
      throw new Error('Supabase CLI dry-run failed: ' + redact(cli.stderr || 'unknown'));
    const start = cli.stdout.indexOf('#!/usr/bin/env bash');
    if (start < 0) throw new Error('CLI did not return expected backup script');
    let script = cli.stdout
      .slice(start)
      .replace(/^export PG(?:HOST|PORT|USER|PASSWORD|DATABASE)=.*\r?\n/gm, '');
    // Save unmodified filter semantics in an inspectable artifact and use env supplied above.
    writeFileSync(join(out, `${name}-script.sh`), script, { mode: 0o600 });
    await docker([
      'bash',
      '-c',
      `set -euo pipefail; bash /backup/${name}-script.sh > /backup/${name}.sql`,
    ]);
    console.log(JSON.stringify({ phase: 'logical-backup-complete', part: name }));
  }
  const files = ['full-source.dump', ...modes.map(([n]) => n + '.sql')];
  const manifest = files.map((name) => {
    const b = readFileSync(join(out, name));
    return { name, bytes: b.length, sha256: createHash('sha256').update(b).digest('hex') };
  });
  writeFileSync(
    join(out, 'backup-manifest.json'),
    JSON.stringify(
      {
        projectRef: expectedRef,
        capturedAt: new Date().toISOString(),
        livePreflight: true,
        files: manifest,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      phase: 'complete',
      files: manifest.map((x) => ({ name: x.name, bytes: x.bytes })),
      output: out,
    }),
  );
} catch (error) {
  console.error(redact(String(error.message)));
  process.exitCode = 1;
}
