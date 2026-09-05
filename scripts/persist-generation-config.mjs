import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
// Input is docker inspect JSON over stdin, never a command-line secret.
const inspected = JSON.parse(readFileSync(0, 'utf8'));
const container = inspected[0];
if (container.Name !== '/zhiyu') throw new Error('Unexpected source container');
const values = Object.fromEntries(
  container.Config.Env.map((line) => {
    const at = line.indexOf('=');
    return [line.slice(0, at), line.slice(at + 1)];
  }),
);
const url = new URL(values.DATABASE_URL);
if (
  !['postgres', 'openmaic-main-postgres-1'].includes(url.hostname) ||
  url.pathname !== '/openmaic'
)
  throw new Error('Unexpected database identity');
let source = readFileSync('.env.local', 'utf8');
if (!existsSync('.scratch/generation-backup-20260905/env.local.before-generation'))
  copyFileSync('.env.local', '.scratch/generation-backup-20260905/env.local.before-generation');
function existing(key) {
  return new RegExp(`^${key}=.+$`, 'm').test(source);
}
function set(key, value) {
  if (/[\r\n]/.test(value))
    throw new Error(`Multiline configuration requires manual review: ${key}`);
  const line = `${key}='${value.replace(/'/g, "\\'")}'`;
  const matcher = new RegExp(`^${key}=.*$`, 'm');
  source = matcher.test(source)
    ? source.replace(matcher, () => line)
    : `${source.trimEnd()}\n${line}\n`;
}
// Preserve configured runtime provider and feature settings from the running app.
const allowed = new Set(
  [
    ...readFileSync('docker-compose.persistence.yml', 'utf8').matchAll(/\$\{([A-Z][A-Z0-9_]*)/g),
  ].map((match) => match[1]),
);
for (const [key, value] of Object.entries(values))
  if (allowed.has(key) && key !== 'DATABASE_URL' && value) set(key, value);
set('PERSISTENCE_POSTGRES_PASSWORD', decodeURIComponent(url.password));
url.hostname = 'postgres';
set('DATABASE_URL', url.toString());
set('PARALLEL_SCENE_CONCURRENCY', '2');
set('NEXT_PUBLIC_PERSISTENCE', '1');
// A public compatibility token is deliberately separate from DB/API credentials.
const previousToken = source.match(/^PERSISTENCE_DEV_TOKEN='([^']+)'$/m)?.[1];
const publicToken =
  values.PERSISTENCE_DEV_TOKEN || previousToken || randomBytes(24).toString('hex');
set('PERSISTENCE_DEV_TOKEN', publicToken);
set('NEXT_PUBLIC_PERSISTENCE_TOKEN', publicToken);
if (!existing('GENERATION_SESSION_SECRET'))
  set('GENERATION_SESSION_SECRET', randomBytes(48).toString('hex'));
set('GENERATION_ALLOWED_ORIGINS', 'http://localhost:3000,http://127.0.0.1:3000');
set('GENERATION_BACKGROUND_ENABLED', '0');
set('GENERATION_ACCEPTING_JOBS', '0');
// Explicit trusted localhost migration preserves the existing anonymous owner.
set('GENERATION_TRUST_LEGACY_OWNER', '1');
writeFileSync('.env.local', source);
console.info(
  'Existing runtime configuration persisted; background acceptance remains disabled. No secret values displayed.',
);
