#!/usr/bin/env node
/**
 * Packaging smoke test for the pi-ai model runtime.
 *
 * For each runtime directory (the Next standalone output and the generation
 * worker's runtime root), a child Node process whose resolution base is that
 * directory verifies:
 *   - `@earendil-works/pi-ai` (root, 0.99.x), its `providers/deepseek` and
 *     `api/openai-completions` subpaths import successfully;
 *   - the real lib/model-gateway/adapters/agent-legacy-pi.ts loader (bundled
 *     with esbuild; it only imports Node builtins) resolves pi-agent-core's own
 *     pi-ai 0.78.x, loads its interop API, and that instance is the very file
 *     agent-core imports.
 * For a Next build it also scans `.next/server` to make sure webpack did not
 * statically rewrite the loader's runtime resolver.
 *
 * Usage:
 *   node scripts/smoke-pi-runtime.mjs                     # .next/standalone and repo root (dist-worker)
 *   node scripts/smoke-pi-runtime.mjs --dir <path>...     # explicit runtime directories
 *   node scripts/smoke-pi-runtime.mjs --emit-loader <f>   # only write the bundled loader (for containers)
 *   node scripts/smoke-pi-runtime.mjs --loader <f> ...    # use a prebuilt loader bundle
 *
 * Resolutions must stay inside the runtime directory (Docker copies it alone).
 * Windows' local standalone output links pnpm junctions to absolute repo paths,
 * so that check is skipped on win32; run the smoke inside the Linux image for
 * the authoritative standalone result.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOADER_SOURCE = path.join(repoRoot, 'lib/model-gateway/adapters/agent-legacy-pi.ts');
const LOADER_MARKER = 'does not expose the agent interop API';

function parseArgs(argv) {
  const args = { dirs: [], loader: undefined, emitLoader: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const next = argv[i + 1];
    if (argv[i] === '--dir' && next) args.dirs.push(next);
    else if (argv[i] === '--loader' && next) args.loader = path.resolve(next);
    else if (argv[i] === '--emit-loader' && next) args.emitLoader = path.resolve(next);
    else continue;
    i += 1;
  }
  return args;
}

async function bundleLoader(outfile) {
  const requireFromRepo = createRequire(path.join(repoRoot, 'package.json'));
  const { build } = createRequire(requireFromRepo.resolve('tsx/package.json'))('esbuild');
  await build({
    entryPoints: [LOADER_SOURCE],
    outfile,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    bundle: true,
    logLevel: 'silent',
  });
  return outfile;
}

function listJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const file = path.join(dir, entry);
    const stat = statSync(file);
    if (stat.isDirectory()) out.push(...listJsFiles(file));
    else if (file.endsWith('.js')) out.push(file);
  }
  return out;
}

/** The loader must reach Node's resolver at runtime, not a webpack rewrite. */
function checkNextBundle(serverDir) {
  const problems = [];
  let found = 0;
  for (const file of listJsFiles(serverDir)) {
    const source = readFileSync(file, 'utf8');
    if (!source.includes(LOADER_MARKER)) continue;
    found += 1;
    if (!source.includes('getBuiltinModule')) {
      problems.push(
        `${path.relative(serverDir, file)}: agent-legacy-pi resolver was rewritten by webpack`,
      );
    }
  }
  if (found === 0) problems.push('agent-legacy-pi loader not found in .next/server');
  return problems;
}

const CHILD = String.raw`
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const PI_AI = '@earendil-works/pi-ai';
const base = pathToFileURL(path.join(process.cwd(), 'package.json')).href;
const strict = process.env.SMOKE_STRICT === '1';
const targetDir = realpathSync(process.cwd());
const out = {};

function inside(fileUrlOrPath) {
  if (!strict) return fileUrlOrPath;
  const file = realpathSync(fileUrlOrPath.startsWith('file:') ? fileURLToPath(fileUrlOrPath) : fileUrlOrPath);
  if (!(file + path.sep).startsWith(targetDir + path.sep)) {
    throw new Error('resolved outside the runtime directory: ' + file);
  }
  return fileUrlOrPath;
}

function packageDirOf(fileUrl) {
  let dir = path.dirname(fileURLToPath(fileUrl));
  while (!existsSync(path.join(dir, 'package.json'))) dir = path.dirname(dir);
  return realpathSync(dir);
}

const rootUrl = inside(import.meta.resolve(PI_AI, base));
const rootDir = packageDirOf(rootUrl);
out.rootVersion = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8')).version;
await import(rootUrl);
const deepseek = await import(inside(import.meta.resolve(PI_AI + '/providers/deepseek', base)));
out.deepseekExports = Object.keys(deepseek);
const completions = await import(inside(import.meta.resolve(PI_AI + '/api/openai-completions', base)));
out.openaiCompletionsExports = Object.keys(completions);

// The real loader, exactly as the application uses it.
const loader = await import(process.env.SMOKE_LOADER_URL);
const location = loader.locateAgentLegacyPi();
inside(location.entryFile);
const legacy = await loader.loadAgentLegacyPi();
out.legacyVersion = legacy.version;
out.legacyApi = ['registerApiProvider', 'unregisterApiProviders', 'createAssistantMessageEventStream']
  .filter((name) => typeof legacy[name] === 'function');

// What agent-core itself imports (its compaction module does
// "import { completeSimple } from '@earendil-works/pi-ai'").
const agentCoreEntry = import.meta.resolve('@earendil-works/pi-agent-core', base);
const agentCoreSees = import.meta.resolve(PI_AI, agentCoreEntry);
out.sameInstance = realpathSync(fileURLToPath(agentCoreSees)) === realpathSync(location.entryFile);
out.distinctFromRoot = realpathSync(location.packageDir) !== rootDir;
console.log(JSON.stringify(out));
`;

const args = parseArgs(process.argv.slice(2));
if (args.emitLoader) {
  await bundleLoader(args.emitLoader);
  console.log(`[smoke-pi-runtime] wrote ${args.emitLoader}`);
  process.exit(0);
}
const loaderFile =
  args.loader ?? (await bundleLoader(path.join(tmpdir(), 'smoke-agent-legacy-pi.mjs')));
const strict = process.platform !== 'win32';
const targets =
  args.dirs.length > 0
    ? args.dirs.map((dir) => ({ label: dir, dir: path.resolve(dir) }))
    : [
        { label: '.next/standalone', dir: path.join(repoRoot, '.next', 'standalone') },
        {
          label: 'dist-worker (repo root)',
          dir: repoRoot,
          requireFile: 'dist-worker/generation.mjs',
        },
      ];
if (!strict) {
  console.warn('[smoke-pi-runtime] win32: runtime-directory containment not enforced (see header)');
}

let failed = false;
for (const target of targets) {
  const prefix = `[smoke-pi-runtime] ${target.label}:`;
  if (!existsSync(target.dir)) {
    console.error(`${prefix} missing directory ${target.dir} (run the build first)`);
    failed = true;
    continue;
  }
  if (target.requireFile && !existsSync(path.join(target.dir, target.requireFile))) {
    console.error(`${prefix} missing ${target.requireFile} (run pnpm build:worker first)`);
    failed = true;
    continue;
  }
  const child = spawnSync(
    process.execPath,
    ['--experimental-import-meta-resolve', '--input-type=module', '-e', CHILD],
    {
      cwd: target.dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        SMOKE_STRICT: strict ? '1' : '0',
        SMOKE_LOADER_URL: pathToFileURL(loaderFile).href,
      },
    },
  );
  if (child.status !== 0) {
    console.error(`${prefix} FAILED\n${child.stderr || child.stdout}`);
    failed = true;
    continue;
  }
  const result = JSON.parse(child.stdout.trim().split('\n').pop());
  const problems = [];
  if (!/^0\.99\./.test(result.rootVersion))
    problems.push(`root pi-ai ${result.rootVersion} != 0.99.x`);
  if (!/^0\.78\./.test(result.legacyVersion))
    problems.push(`agent-core pi-ai ${result.legacyVersion} != 0.78.x`);
  if (result.legacyApi.length !== 3)
    problems.push(`legacy interop API incomplete: ${result.legacyApi}`);
  if (!result.sameInstance)
    problems.push('legacy loader does not match the pi-ai agent-core imports');
  if (!result.distinctFromRoot) problems.push('agent-core pi-ai is the root copy');
  if (result.deepseekExports.length === 0) problems.push('providers/deepseek has no exports');
  if (result.openaiCompletionsExports.length === 0)
    problems.push('api/openai-completions has no exports');
  const serverDir = path.join(target.dir, '.next', 'server');
  if (existsSync(serverDir)) problems.push(...checkNextBundle(serverDir));
  if (problems.length > 0) {
    console.error(`${prefix} FAILED\n  - ${problems.join('\n  - ')}`);
    failed = true;
  } else {
    console.log(
      `${prefix} ok (pi-ai ${result.rootVersion}; agent-core pi-ai ${result.legacyVersion}; ` +
        `deepseek exports: ${result.deepseekExports.join(',')})`,
    );
  }
}
process.exit(failed ? 1 : 0);
