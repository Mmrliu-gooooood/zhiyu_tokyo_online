/**
 * Resumable hosted-account deletion operator.
 *
 * Dry-run by default. A real run requires all of:
 *   --apply
 *   CONFIRM_DELETE_ACCOUNT=YES
 *   --email=<exact disposable or explicitly approved account email>
 *
 * The migration administrator is additionally protected by
 * MIGRATION_ADMIN_USER_ID unless ALLOW_DELETE_MIGRATION_ADMIN=YES is set.
 */
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';

import {
  deleteAccountObjects,
  deleteAccountRelations,
  findResumableAccountDeletionByEmail,
  finalizeAccountDeletion,
  prepareAccountDeletionManifest,
  requestAccountDeletion,
  type AccountDeletionObjectStore,
} from '../lib/server/accounts/deletion';
import { createSupabaseAdminClient } from '../lib/supabase/admin';
import { getSupabaseSecretKey } from '../lib/supabase/env';
import {
  hostedAdminDatabaseUrl,
  hostedPgPool,
  loadHostedOperatorEnv,
} from './lib/hosted-operator-env';
import { lookupReservedAdmin } from './lib/test-admin-lifecycle';

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .find((value) => value.startsWith(prefix))
    ?.slice(prefix.length)
    .trim();
}

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function objectStore(): AccountDeletionObjectStore {
  const endpoint = required('ASSET_S3_ENDPOINT', process.env.ASSET_S3_ENDPOINT?.trim());
  const region = required('ASSET_S3_REGION', process.env.ASSET_S3_REGION?.trim());
  const accessKeyId = required(
    'ASSET_S3_ACCESS_KEY_ID',
    process.env.ASSET_S3_ACCESS_KEY_ID?.trim(),
  );
  const secretAccessKey = required(
    'ASSET_S3_SECRET_ACCESS_KEY',
    process.env.ASSET_S3_SECRET_ACCESS_KEY?.trim(),
  );
  const client = new S3Client({
    endpoint,
    region,
    forcePathStyle: process.env.ASSET_S3_FORCE_PATH_STYLE !== 'false',
    credentials: { accessKeyId, secretAccessKey },
  });
  return {
    async delete(bucketId, objectKey) {
      await client.send(new DeleteObjectCommand({ Bucket: bucketId, Key: objectKey }));
    },
  };
}

async function main() {
  loadHostedOperatorEnv();
  const email = required('delete target --email', arg('email'));
  const dryRun = !process.argv.includes('--apply');
  const authTarget = await lookupReservedAdmin(email);
  let pool: ReturnType<typeof hostedPgPool> | undefined;
  let userId = authTarget?.userId;
  let recoveryStatus: string | undefined;
  if (!userId) {
    const databaseUrl = required('HOSTED_DB_ADMIN_URL', hostedAdminDatabaseUrl());
    pool = hostedPgPool(databaseUrl);
    try {
      const recoveryJob = await findResumableAccountDeletionByEmail(pool, email);
      userId = recoveryJob?.userId;
      recoveryStatus = recoveryJob?.status;
    } catch (error) {
      await pool.end();
      throw error;
    }
  }
  if (!userId) {
    await pool?.end();
    throw new Error('Target account or resumable deletion job was not found');
  }

  console.info(
    JSON.stringify({
      dryRun,
      recovery: !authTarget,
      role: authTarget?.role,
      status: authTarget?.status ?? recoveryStatus,
      owned: authTarget?.owned,
    }),
  );
  if (dryRun) {
    await pool?.end();
    return;
  }

  if (process.env.CONFIRM_DELETE_ACCOUNT !== 'YES') {
    await pool?.end();
    throw new Error('Refusing deletion: set CONFIRM_DELETE_ACCOUNT=YES and pass --apply');
  }
  const protectedAdmin = process.env.MIGRATION_ADMIN_USER_ID?.trim();
  if (!protectedAdmin) {
    await pool?.end();
    throw new Error('MIGRATION_ADMIN_USER_ID is required');
  }
  if (
    protectedAdmin &&
    protectedAdmin === userId &&
    process.env.ALLOW_DELETE_MIGRATION_ADMIN !== 'YES'
  ) {
    await pool?.end();
    throw new Error('Refusing to delete the protected migration administrator');
  }
  if (!getSupabaseSecretKey()) {
    await pool?.end();
    throw new Error('SUPABASE_SECRET_KEY is required');
  }
  pool ??= hostedPgPool(required('HOSTED_DB_ADMIN_URL', hostedAdminDatabaseUrl()));
  try {
    const admin = createSupabaseAdminClient();
    await requestAccountDeletion(pool, userId, { recoveryEmail: email });
    const { error: blockError } = await admin.auth.admin.updateUserById(userId, {
      ban_duration: '876000h',
    });
    if (blockError && !/not found/i.test(blockError.message)) throw blockError;

    await prepareAccountDeletionManifest(pool, userId, {
      assets: process.env.ASSET_S3_BUCKET?.trim() || 'zhiyu-assets',
      materials: process.env.MATERIAL_S3_BUCKET?.trim() || 'zhiyu-materials',
      classrooms: process.env.CLASSROOM_S3_BUCKET?.trim() || 'zhiyu-classrooms',
    });
    await deleteAccountRelations(pool, userId);
    // Relation cleanup re-evaluates shared hashes, so a manifest entry can
    // legitimately change from retained_shared to pending at this point.
    await deleteAccountObjects(pool, userId, objectStore());
    await finalizeAccountDeletion(pool, userId, {
      async block(userId) {
        const { error } = await admin.auth.admin.updateUserById(userId, {
          ban_duration: '876000h',
        });
        if (error && !/not found/i.test(error.message)) throw error;
      },
      async delete(userId) {
        const { error } = await admin.auth.admin.deleteUser(userId);
        if (error && !/not found/i.test(error.message)) throw error;
      },
    });
    console.info(JSON.stringify({ dryRun: false, deleted: true }));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    message
      .replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, 'postgresql://***@')
      .replace(/password[=:]\s*\S+/gi, 'password=***')
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]')
      .replace(
        /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
        '[redacted-id]',
      ),
  );
  process.exitCode = 1;
});
