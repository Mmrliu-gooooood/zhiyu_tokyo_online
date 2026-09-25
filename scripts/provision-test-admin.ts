/**
 * Create the reserved test-admin Auth user. Default is dry-run.
 * Never prints the password. Never runs on application startup.
 * TEST_ADMIN_EMAIL must be supplied by the operator; do not invent a mailbox.
 *
 *   TEST_ADMIN_EMAIL=... TEST_ADMIN_PASSWORD=... pnpm accounts:provision-test-admin
 *   TEST_ADMIN_EMAIL=... TEST_ADMIN_PASSWORD=... pnpm accounts:provision-test-admin -- --apply
 */
import { createSupabaseAdminClient } from '../lib/supabase/admin';
import { getSupabaseSecretKey } from '../lib/supabase/env';
import {
  hostedAdminDatabaseUrl,
  hostedPgPool,
  loadHostedOperatorEnv,
} from './lib/hosted-operator-env';
import {
  lookupReservedAdmin,
  MIN_TEST_ADMIN_PASSWORD_LENGTH,
} from './lib/test-admin-lifecycle';

function hasApplyFlag(): boolean {
  return process.argv.includes('--apply');
}

async function main() {
  loadHostedOperatorEnv();
  const email = process.env.TEST_ADMIN_EMAIL?.trim();
  const password = process.env.TEST_ADMIN_PASSWORD ?? '';
  const apply = hasApplyFlag();

  if (!email) {
    throw new Error('TEST_ADMIN_EMAIL is required');
  }
  if (apply && password.length < MIN_TEST_ADMIN_PASSWORD_LENGTH) {
    throw new Error(
      `TEST_ADMIN_PASSWORD must be at least ${MIN_TEST_ADMIN_PASSWORD_LENGTH} characters for --apply`,
    );
  }

  const found = await lookupReservedAdmin(email);

  if (!apply) {
    console.info(
      JSON.stringify(
        {
          dryRun: true,
          email,
          exists: Boolean(found),
          userId: found?.userId ?? null,
          emailConfirmed: found?.emailConfirmed ?? null,
          role: found?.role ?? null,
          lookup: found?.lookup ?? null,
          next: found
            ? 'User already exists. --apply will refuse to overwrite the password or promote this account.'
            : 'Pass --apply to create a pre-confirmed admin user. The password is not printed.',
        },
        null,
        2,
      ),
    );
    return;
  }

  if (found) {
    throw new Error(
      'A user with this email already exists. Refusing to overwrite the password or promote an unknown account.',
    );
  }
  if (!getSupabaseSecretKey()) {
    throw new Error('SUPABASE_SECRET_KEY is required to create a new admin user');
  }
  const connectionString = hostedAdminDatabaseUrl();
  if (!connectionString) {
    throw new Error('HOSTED_DB_ADMIN_URL is required to create a new admin user safely');
  }

  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: 'admin' },
  });
  if (error || !data.user) {
    throw error ?? new Error('Admin user creation failed');
  }

  const pool = hostedPgPool(connectionString);
  try {
    await pool.query(
      `INSERT INTO app_accounts (user_id, owner_id, role, status)
       VALUES ($1::uuid, 'user:' || $1::text, 'admin', 'active')
       ON CONFLICT (user_id) DO UPDATE
       SET role = 'admin', status = 'active', updated_at = clock_timestamp()
       WHERE app_accounts.role = 'user' AND app_accounts.status = 'active'`,
      [data.user.id],
    );
    const role = await pool.query<{ role: string }>(
      'SELECT role FROM app_accounts WHERE user_id = $1',
      [data.user.id],
    );
    if (role.rows[0]?.role !== 'admin') {
      throw new Error('Failed to assign admin role; no password was logged');
    }
    await pool.query(
      `INSERT INTO admin_audit_events (actor_user_id, target_internal_id, action, result)
       VALUES ($1, $1, 'provision_test_admin', 'created')`,
      [data.user.id],
    );
  } catch (error) {
    // Do not leave a confirmed ordinary account behind when role assignment
    // fails after Auth creation. This is a best-effort compensation; surface
    // both failures without printing credentials.
    const cleanup = await admin.auth.admin.deleteUser(data.user.id);
    if (cleanup.error) {
      throw new AggregateError([error, cleanup.error], 'Admin provisioning failed and cleanup failed');
    }
    throw error;
  } finally {
    await pool.end();
  }

  console.info(
    JSON.stringify(
      {
        dryRun: false,
        email,
        userId: data.user.id,
        role: 'admin',
        emailConfirmed: true,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
