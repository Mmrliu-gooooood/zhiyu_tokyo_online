/** Export project configuration to private local artifacts; prints field names only. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseEnv } from 'node:util';
const ref = process.argv[2];
if (!/^[a-z]{20}$/.test(ref || '')) throw new Error('Project ref required');
const root = resolve('.scratch/supabase-tokyo-20260925');
const { SUPABASE_ACCESS_TOKEN: token } = parseEnv(
  readFileSync(join(root, 'management.env'), 'utf8'),
);
if (!token) throw new Error('Management token missing');
const out = join(root, ref, 'platform');
mkdirSync(out, { recursive: true });
const endpoints = {
  project: '',
  auth: '/config/auth',
  storage: '/config/storage',
  realtime: '/config/realtime',
  postgrest: '/postgrest',
  pooler: '/config/database/pooler',
  ssl: '/ssl-enforcement',
  addons: '/billing/addons',
  apiKeys: '/api-keys?reveal=true',
  postgres: '/config/database/postgres',
  network: '/network-restrictions',
  hostname: '/custom-hostname',
  vanity: '/vanity-subdomain',
  secrets: '/secrets',
  backups: '/database/backups',
};
const report = [];
for (const [name, path] of Object.entries(endpoints)) {
  let response;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      response = await fetch(`https://api.supabase.com/v1/projects/${ref}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(60000),
      });
      break;
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
  const body = await response.json();
  writeFileSync(join(out, `${name}.json`), JSON.stringify(body, null, 2), { mode: 0o600 });
  report.push({ name, status: response.status, fields: Object.keys(body) });
  console.log(
    JSON.stringify({
      name,
      status: response.status,
      fieldCount: Object.keys(body).length,
      ...(name === 'auth'
        ? { smtpPasswordPresent: typeof body.smtp_pass === 'string' && body.smtp_pass.length > 0 }
        : {}),
    }),
  );
}
writeFileSync(
  join(out, 'snapshot-manifest.json'),
  JSON.stringify({ ref, time: new Date().toISOString(), report }, null, 2),
  { mode: 0o600 },
);
if (report.some((x) => x.status !== 200)) process.exitCode = 1;
