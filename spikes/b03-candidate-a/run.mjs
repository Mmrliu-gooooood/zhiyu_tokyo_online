// Candidate A spike runner: throwaway PostgreSQL 17 + PGroonga + pgvector
// container on 127.0.0.1:55434, schema, bundled spike, report, teardown.
//
//   node spikes/b03-candidate-a/run.mjs          (fake embeddings)
//   node spikes/b03-candidate-a/run.mjs --keep   (leave the container running)
//
// Real embeddings only with explicit approval: SPIKE_EMBEDDING=http plus
// SPIKE_EMBED_URL / SPIKE_EMBED_KEY / SPIKE_EMBED_MODEL in the environment.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('tsx/package.json'))('esbuild');
const here = resolve(import.meta.dirname);
const root = resolve(here, '../..');
const out = resolve(root, '.scratch/b03-spike');
mkdirSync(out, { recursive: true });

const name = 'zhiyu-b03-spike-pg';
const port = '55434';
const docker = (...args) => execFileSync('docker', args, { stdio: 'pipe' }).toString().trim();

spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
docker('build', '-t', 'zhiyu-b03-pg:17', here);
docker(
  'run',
  '-d',
  '--name',
  name,
  '-p',
  `127.0.0.1:${port}:5432`,
  '-e',
  'POSTGRES_PASSWORD=spike',
  '-e',
  'POSTGRES_DB=b03_spike',
  '--memory',
  '1g',
  'zhiyu-b03-pg:17',
);
for (let i = 0; i < 60; i += 1) {
  const ready = spawnSync('docker', [
    'exec',
    name,
    'pg_isready',
    '-U',
    'postgres',
    '-d',
    'b03_spike',
  ]);
  if (ready.status === 0) break;
  await new Promise((r) => setTimeout(r, 1000));
}
await new Promise((r) => setTimeout(r, 1500));
execFileSync(
  'docker',
  ['exec', '-i', name, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'b03_spike'],
  {
    input: readFileSync(resolve(here, 'schema.sql')),
    stdio: ['pipe', 'ignore', 'inherit'],
  },
);
const idle = docker('stats', '--no-stream', '--format', '{{.MemUsage}} {{.CPUPerc}}', name);

await build({
  entryPoints: [resolve(here, 'spike.ts')],
  outfile: resolve(out, 'spike.mjs'),
  platform: 'node',
  target: 'node22',
  format: 'esm',
  bundle: true,
  external: ['pg'],
  tsconfig: resolve(root, 'tsconfig.json'),
  logLevel: 'warning',
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});
const run = spawnSync(process.execPath, [resolve(out, 'spike.mjs')], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    SPIKE_DATABASE_URL: `postgres://postgres:spike@127.0.0.1:${port}/b03_spike`,
    SPIKE_OUT: resolve(out, 'report.json'),
  },
});
const busy = docker('stats', '--no-stream', '--format', '{{.MemUsage}} {{.CPUPerc}}', name);
console.log(`container memory/cpu idle: ${idle}; after run: ${busy}`);
if (!process.argv.includes('--keep')) spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
process.exit(run.status ?? 1);
