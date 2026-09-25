/** Target-only setup. All credentials and API response bodies remain gitignored. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
const root = resolve('.scratch/supabase-tokyo-20260925');
const source = 'lzomhnjyymalupgvcato',
  target = 'lvbtgwlsebzbtcvjwktq';
if (!process.argv.includes(`--target=${target}`)) throw new Error('Explicit target required');
const token = parseEnv(readFileSync(join(root, 'management.env'), 'utf8')).SUPABASE_ACCESS_TOKEN;
const load = (ref, name) =>
  JSON.parse(readFileSync(join(root, ref, 'platform', name + '.json'), 'utf8'));
const save = (name, data) =>
  writeFileSync(join(root, target, name), JSON.stringify(data, null, 2), { mode: 0o600 });
async function api(path, method = 'GET', body) {
  let r;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      r = await fetch('https://api.supabase.com' + path, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(60000),
      });
      break;
    } catch (_error) {
      if (attempt === 3) throw new Error('Management connection failed');
    }
  }
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { text };
  }
  if (!r.ok) {
    save('last-error.json', { path, status: r.status, data });
    throw new Error(`Management ${method} ${path}: ${r.status}; private error saved`);
  }
  return data;
}
const action = process.argv[2];
if (action === 'storage') {
  const from = load(source, 'storage');
  const body = {
    fileSizeLimit: from.fileSizeLimit,
    features: from.features,
    external: from.external,
  };
  await api(`/v1/projects/${target}/config/storage`, 'PATCH', body);
  const after = await api(`/v1/projects/${target}/config/storage`);
  save('storage-after.json', after);
  const mismatches = Object.keys(body).filter(
    (key) => JSON.stringify(body[key]) !== JSON.stringify(after[key]),
  );
  console.log(JSON.stringify({ action, mismatches }));
  if (mismatches.length) throw new Error('Storage configuration mismatch');
}
if (action === 'password') {
  const file = join(root, target, 'database-password.json');
  const password = existsSync(file)
    ? JSON.parse(readFileSync(file, 'utf8')).password
    : randomBytes(32).toString('base64url');
  save('database-password.json', { password });
  await api(`/v1/projects/${target}/database/password`, 'PATCH', { password });
  console.log('Tokyo database password set; secret saved privately');
}
if (action === 'auth') {
  const from = load(source, 'auth'),
    to = load(target, 'auth');
  // Response-only maps track whether defaults were customized. Do not send them.
  const skip = new Set([
    'mailer_subjects_custom_contents',
    'mailer_templates_custom_contents',
    'smtp_pass',
  ]);
  const diff = Object.fromEntries(
    Object.entries(from).filter(
      ([k, v]) => !skip.has(k) && JSON.stringify(v) !== JSON.stringify(to[k]),
    ),
  );
  diff.smtp_pass = parseEnv(
    readFileSync(join(root, target, 'resend-smtp.env'), 'utf8'),
  ).RESEND_API_KEY;
  await api(`/v1/projects/${target}/config/auth`, 'PATCH', diff);
  const actual = await api(`/v1/projects/${target}/config/auth`);
  save('auth-after.json', actual);
  // Management responses contain a server-generated digest, not a reversible secret.
  // Only an actual SMTP/Auth delivery probe can verify the password.
  const mismatch = Object.keys(diff).filter(
    (k) => k !== 'smtp_pass' && JSON.stringify(actual[k]) !== JSON.stringify(diff[k]),
  );
  save('auth-comparison.json', {
    changedFields: Object.keys(diff),
    mismatch,
    smtpVerification: 'requires-live-delivery',
  });
  console.log(
    JSON.stringify({
      action,
      changedFields: Object.keys(diff),
      mismatch,
      smtpVerification: 'requires-live-delivery',
    }),
  );
  if (mismatch.length) process.exitCode = 1;
}
if (action === 's3-list') {
  const data = await api(`/platform/storage/${target}/credentials`);
  save('s3-list.json', data);
  console.log(JSON.stringify({ action, fields: Object.keys(data) }));
}
if (action === 'realtime') {
  const from = load(source, 'realtime'),
    to = load(target, 'realtime');
  const diff = Object.fromEntries(
    Object.entries(from).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(to[k])),
  );
  if (Object.keys(diff).length) await api(`/v1/projects/${target}/config/realtime`, 'PATCH', diff);
  save('realtime-after.json', await api(`/v1/projects/${target}/config/realtime`));
  console.log(JSON.stringify({ action, changedFields: Object.keys(diff) }));
}
if (action === 'env') {
  const env = parseEnv(readFileSync('.env.hosted.local', 'utf8'));
  const password = JSON.parse(
    readFileSync(join(root, target, 'database-password.json'), 'utf8'),
  ).password;
  const pool = load(target, 'pooler')[0],
    keys = load(target, 'apiKeys');
  const pub = keys.find((x) => x.type === 'publishable'),
    sec = keys.find((x) => x.type === 'secret');
  if (!pub?.api_key || !sec?.api_key) throw new Error('Target API keys missing');
  for (const [k, v] of Object.entries(env)) {
    if (
      k.includes('DATABASE_URL') ||
      k.includes('DATABASE_LISTEN_URL') ||
      k === 'HOSTED_DB_ADMIN_URL'
    ) {
      if (!v) continue;
      const u = new URL(v);
      u.hostname = pool.db_host;
      u.username = decodeURIComponent(u.username).replace(source, target);
      if (k === 'HOSTED_DB_ADMIN_URL') u.password = password;
      env[k] = u.href;
    } else if (v.includes(source)) env[k] = v.replaceAll(source, target);
  }
  env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = pub.api_key;
  env.SUPABASE_SECRET_KEY = sec.api_key;
  env.ASSET_S3_REGION = 'ap-northeast-1';
  // S3 credentials must be replaced before this file is eligible for cutover.
  Object.assign(env, parseEnv(readFileSync(join(root, target, 's3.env'), 'utf8')));
  writeFileSync(
    join(root, target, 'target-hosted.env'),
    Object.entries(env)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join('\n') + '\n',
    { mode: 0o600 },
  );
  console.log('Target environment staged privately with Tokyo S3 credentials');
}
