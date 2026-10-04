// Bundle a TypeScript operator script with esbuild, then run it. Like
// run-accounts-migration.mjs, for scripts whose imports (the workspace
// storage package's import-only `*/pg` subpaths) plain tsx cannot load.
//
//   node scripts/run-bundled-operator-script.mjs scripts/<entry>.ts [args...]
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { build } from 'esbuild';

const [entry, ...args] = process.argv.slice(2);
if (!entry) throw new Error('usage: run-bundled-operator-script.mjs <entry.ts> [args...]');

const directory = await mkdtemp(path.join(tmpdir(), 'openmaic-operator-script-'));
const outfile = path.join(directory, 'script.cjs');

try {
  await build({
    entryPoints: [path.resolve(entry)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    sourcemap: false,
    tsconfig: path.resolve('tsconfig.json'),
    logLevel: 'warning',
    // The storage package's reference server guards its CLI self-start with
    // import.meta.url; empty in CJS, so the guard is false, as intended here.
    logOverride: { 'empty-import-meta': 'silent' },
  });

  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [outfile, ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`${entry} terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
  process.exitCode = exitCode;
} finally {
  await rm(directory, { recursive: true, force: true });
}
