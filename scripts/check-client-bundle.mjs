/**
 * Client bundle boundary check (model gateway plan, P5 gate / invariant 14):
 * the browser build must not contain the pi-ai protocol modules, the OpenAI
 * SDK or the Anthropic SDK. Run after `pnpm build`.
 *
 * Minified chunks keep string literals, so each module is identified by a
 * literal from its source. Every marker is first confirmed in the installed
 * package (a renamed literal would otherwise make the check vacuous), then
 * searched for in `.next/static`.
 *
 *   node scripts/check-client-bundle.mjs [--static-dir .next/static]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = process.cwd();
const staticDir = path.resolve(
  root,
  process.argv.includes('--static-dir')
    ? process.argv[process.argv.indexOf('--static-dir') + 1]
    : '.next/static',
);

/** Directory of a package as resolved from `fromDir` (follows pnpm links). */
function packageDir(name, fromDir) {
  const requireFrom = createRequire(path.join(fromDir, 'package.json'));
  for (const base of requireFrom.resolve.paths(name) ?? []) {
    const candidate = path.join(base, ...name.split('/'));
    if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate);
  }
  throw new Error(`Cannot locate ${name} from ${fromDir}`);
}

const piDir = packageDir('@earendil-works/pi-ai', root);

const MARKERS = [
  {
    module: '@earendil-works/pi-ai/dist/api/openai-completions',
    file: path.join(piDir, 'dist/api/openai-completions.js'),
    literal: 'Provider returned an error stop reason',
  },
  {
    module: '@earendil-works/pi-ai/dist/api/anthropic-messages',
    file: path.join(piDir, 'dist/api/anthropic-messages.js'),
    literal: 'Anthropic stream ended without a stop reason',
  },
  {
    module: 'openai (SDK used by pi-ai)',
    file: path.join(packageDir('openai', piDir), 'client.js'),
    literal: 'The `apiKey` and `workloadIdentity` options are mutually exclusive',
  },
  {
    module: '@anthropic-ai/sdk (SDK used by pi-ai)',
    file: path.join(packageDir('@anthropic-ai/sdk', piDir), 'client.js'),
    literal: 'anthropic-version',
  },
];

function* files(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(full);
    else if (/\.(m?js)$/.test(entry.name)) yield full;
  }
}

if (!fs.existsSync(staticDir)) {
  console.error(`No client build at ${path.relative(root, staticDir)}; run \`pnpm build\` first.`);
  process.exit(1);
}

let failed = false;
for (const marker of MARKERS) {
  if (!fs.readFileSync(marker.file, 'utf8').includes(marker.literal)) {
    console.error(`Marker for ${marker.module} no longer exists in ${marker.file}; update it.`);
    failed = true;
  }
}

const chunks = [...files(staticDir)];
for (const file of chunks) {
  const text = fs.readFileSync(file, 'utf8');
  for (const marker of MARKERS) {
    if (text.includes(marker.literal)) {
      console.error(`${path.relative(root, file)} contains ${marker.module}`);
      failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log(
  `Client bundle boundary check passed (${chunks.length} chunks; no pi-ai protocol modules, OpenAI SDK or Anthropic SDK).`,
);
