import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { build } from 'esbuild';

const directory = await mkdtemp(path.join(tmpdir(), 'openmaic-storage-migration-'));
const outfile = path.join(directory, 'migrate-supabase-storage.cjs');

try {
  await build({
    entryPoints: [path.resolve('scripts/migrate-supabase-storage.mts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    sourcemap: false,
    tsconfig: path.resolve('tsconfig.json'),
    logLevel: 'warning',
  });

  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [outfile, ...process.argv.slice(2)], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`Storage migration terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
  process.exitCode = exitCode;
} finally {
  await rm(directory, { recursive: true, force: true });
}
