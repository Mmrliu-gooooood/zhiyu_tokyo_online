/** Verify migrated ciphertext and existing logins; never logs secrets or plaintext. */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { resolve, join } from 'node:path';
import { createDecipheriv } from 'node:crypto';
import pg from 'pg';
const root = resolve('.scratch/supabase-tokyo-20260925'),
  ref = 'lvbtgwlsebzbtcvjwktq';
if (!process.argv.includes(`--target=${ref}`)) throw Error('Target confirmation required');
const env = {
  ...parseEnv(readFileSync('.env.local', 'utf8')),
  ...parseEnv(readFileSync(join(root, ref, 'target-hosted.env'), 'utf8')),
};
const u = new URL(env.HOSTED_DB_ADMIN_URL);
for (const k of ['sslmode', 'sslrootcert', 'uselibpqcompat']) u.searchParams.delete(k);
const db = new pg.Client({
  connectionString: u.href,
  ssl: { ca: readFileSync(env.SUPABASE_DB_SSL_ROOT_CERT_PATH, 'utf8'), rejectUnauthorized: true },
  connectionTimeoutMillis: 30000,
});
const report = { decryption: [], logins: [] };
try {
  await db.connect();
  const specs = [
    [
      'media-config:v1',
      'MEDIA_CONFIG_ENCRYPTION_KEY',
      'select id,owner_id,revision,ciphertext from public.media_config_snapshots',
    ],
    [
      'generation-model:v1',
      'GENERATION_MODEL_ENCRYPTION_KEY',
      'select id,owner_id,revision,ciphertext from public.generation_model_snapshots',
    ],
    [
      'pro-model:v1',
      'PRO_MODEL_ENCRYPTION_KEY',
      'select c.id,c.owner_id,r.revision,r.ciphertext from public.pro_model_connections c join public.pro_model_connection_revisions r on r.connection_id=c.id',
    ],
  ];
  for (const [type, key, sql] of specs) {
    const rows = (await db.query(sql)).rows;
    for (const row of rows) {
      const [v, iv, tag, body, extra] = row.ciphertext.split('.');
      if (v !== 'v1' || extra) throw Error('Ciphertext format mismatch');
      const d = createDecipheriv(
        'aes-256-gcm',
        Buffer.from(env[key], 'hex'),
        Buffer.from(iv, 'base64'),
      );
      d.setAAD(Buffer.from(JSON.stringify([type, row.owner_id, row.id, row.revision])));
      d.setAuthTag(Buffer.from(tag, 'base64'));
      JSON.parse(
        Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8'),
      );
    }
    report.decryption.push({ type, count: rows.length, ok: true });
  }
  for (const actor of ['TEST_ADMIN', 'TEST_USER_A', 'TEST_USER_B']) {
    const r = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        apikey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email: env[actor + '_EMAIL'], password: env[actor + '_PASSWORD'] }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await r.json();
    report.logins.push({ actor, status: r.status, ok: r.ok && Boolean(data.access_token) });
    if (!r.ok) throw Error('Target password login failed: ' + r.status);
  }
  console.log(JSON.stringify(report));
} finally {
  await db.end();
  writeFileSync(
    join(root, ref, 'secrets-and-auth-verification.json'),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
}
