// Bundle and run the B03 evaluation (eval/study-qa/runner.ts) with Node 24.
//   EVAL_STUDY_DATABASE_URL=... node eval/study-qa/run.mjs [--answers]
// The bundle goes to .scratch/ (gitignored); reports to eval/study-qa/results/.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('tsx/package.json'))('esbuild');
const root = resolve(import.meta.dirname, '../..');
const out = resolve(root, '.scratch/study-qa-eval');
mkdirSync(out, { recursive: true });

export async function bundleStudyQaEval() {
  const outfile = resolve(out, 'runner.mjs');
  await build({
    entryPoints: [resolve(root, 'eval/study-qa/runner.ts')],
    outfile,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    bundle: true,
    external: ['pg', '@earendil-works/pi-ai', 'undici', 'sharp', '@electric-sql/pglite'],
    tsconfig: resolve(root, 'tsconfig.json'),
    logLevel: 'warning',
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
  });
  return outfile;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const outfile = await bundleStudyQaEval();
  const run = spawnSync(process.execPath, [outfile, ...process.argv.slice(2)], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, STUDY_QA_EVAL_MAIN: '1' },
  });
  process.exit(run.status ?? 1);
}
