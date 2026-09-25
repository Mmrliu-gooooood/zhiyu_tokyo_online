/** Resume-safe target object transfer; every uploaded object is downloaded and SHA-256 checked. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseEnv } from 'node:util';
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
const root = resolve('.scratch/supabase-tokyo-20260925');
const ref = 'lvbtgwlsebzbtcvjwktq';
if (!process.argv.includes(`--target=${ref}`)) throw new Error('Target confirmation missing');
const env = parseEnv(readFileSync(join(root, ref, 'target-hosted.env'), 'utf8'));
if (new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname !== ref + '.supabase.co')
  throw new Error('Target mismatch');
const source = join(root, 'source-preflight');
const manifest = JSON.parse(readFileSync(join(source, 'storage-backup-manifest.json'), 'utf8'));
const buckets = JSON.parse(readFileSync(join(source, 'storage-buckets.json'), 'utf8'));
const api = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
for (const b of buckets) {
  let data, error;
  for (let attempt = 0; attempt < 4; attempt++) {
    ({ data, error } = await api.storage.getBucket(b.id));
    if (!error || String(error.status) === '404') break;
  }
  if (error && String(error.status) !== '404')
    throw Error(`Bucket lookup failed: ${error.status} ${error.message}`);
  if (error) {
    const r = await api.storage.createBucket(b.id, {
      public: b.public,
      fileSizeLimit: b.file_size_limit,
      allowedMimeTypes: b.allowed_mime_types,
    });
    if (r.error) throw Error(r.error.message);
  } else if (data.public !== b.public) throw Error('Bucket privacy mismatch');
}
const s3 = new S3Client({
  endpoint: env.ASSET_S3_ENDPOINT,
  region: env.ASSET_S3_REGION,
  forcePathStyle: true,
  credentials: {
    accessKeyId: env.ASSET_S3_ACCESS_KEY_ID,
    secretAccessKey: env.ASSET_S3_SECRET_ACCESS_KEY,
  },
  maxAttempts: 5,
});
const progress = join(root, ref, 'storage-transfer.json');
const results = existsSync(progress) ? JSON.parse(readFileSync(progress, 'utf8')) : [];
const done = new Map(results.map((x) => [JSON.stringify([x.bucket, x.key]), x.sha256]));
const hash = (x) => createHash('sha256').update(x).digest('hex');
const save = () => writeFileSync(progress, JSON.stringify(results, null, 2), { mode: 0o600 });
let index = 0;
async function worker() {
  for (;;) {
    const item = manifest[index++];
    if (!item) return;
    if (done.get(JSON.stringify([item.bucket, item.key])) === item.sha256) continue;
    const body = readFileSync(item.localFile);
    if (hash(body) !== item.sha256) throw Error('Local backup integrity mismatch');
    await s3.send(
      new PutObjectCommand({
        Bucket: item.bucket,
        Key: item.key,
        Body: body,
        ContentType: item.contentType,
        CacheControl: item.cacheControl,
        Metadata: item.metadata,
      }),
    );
    const r = await s3.send(new GetObjectCommand({ Bucket: item.bucket, Key: item.key }));
    const received = Buffer.from(await r.Body.transformToByteArray());
    if (received.length !== item.size || hash(received) !== item.sha256)
      throw Error('Target object integrity mismatch');
    if (
      r.ContentType !== item.contentType ||
      r.CacheControl !== item.cacheControl ||
      JSON.stringify(r.Metadata) !== JSON.stringify(item.metadata)
    )
      throw Error('Target object header mismatch');
    results.push({
      bucket: item.bucket,
      key: item.key,
      size: item.size,
      sha256: item.sha256,
      verifiedAt: new Date().toISOString(),
    });
    if (results.length % 50 === 0) {
      save();
      console.log(
        JSON.stringify({
          phase: 'object-copy-verified',
          completed: results.length,
          total: manifest.length,
        }),
      );
    }
  }
}
try {
  const outcomes = await Promise.allSettled(Array.from({ length: 4 }, worker));
  save();
  const failed = outcomes.find((x) => x.status === 'rejected');
  if (failed) throw failed.reason;
  console.log(
    JSON.stringify({
      phase: 'complete',
      objects: results.length,
      bytes: results.reduce((n, x) => n + x.size, 0),
    }),
  );
} catch (e) {
  save();
  console.error(e.name, e.message);
  process.exitCode = 1;
} finally {
  s3.destroy();
}
