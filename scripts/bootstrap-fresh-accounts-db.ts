/**
 * Build a fresh disposable or staging database up to the latest accounts
 * version, in production's order (lib/server/accounts/fresh-bootstrap.ts).
 * Never production: the production project is refused outright, and any
 * database with recorded accounts versions or existing rows is refused.
 *
 *   ACCOUNTS_BOOTSTRAP_DATABASE_URL=postgres://admin@127.0.0.1:55432/staging_db \
 *     pnpm accounts:bootstrap-fresh --confirm-database=staging_db [--stub-supabase-auth]
 *
 * --stub-supabase-auth creates the Supabase Auth objects the accounts SQL
 * references (anon/authenticated roles, auth.users, auth.sessions, auth.uid())
 * when missing; use it on plain PostgreSQL, not on Supabase. Hosted LOGIN
 * roles and test accounts are not created here.
 */
import { Pool } from 'pg';

import { bootstrapFreshAccountsDatabase } from '../lib/server/accounts/fresh-bootstrap';
import { HOSTED_PROJECT_REF } from './lib/hosted-operator-env';

async function main() {
  const connectionString = process.env.ACCOUNTS_BOOTSTRAP_DATABASE_URL?.trim();
  if (!connectionString) throw new Error('ACCOUNTS_BOOTSTRAP_DATABASE_URL is required');
  if (connectionString.includes(HOSTED_PROJECT_REF)) {
    throw new Error('Refusing fresh accounts bootstrap on the production Supabase project');
  }
  const database = decodeURIComponent(new URL(connectionString).pathname.replace(/^\//, ''));
  const confirmed = process.argv
    .find((arg) => arg.startsWith('--confirm-database='))
    ?.slice('--confirm-database='.length);
  if (!database || confirmed !== database) {
    throw new Error('Pass --confirm-database=<database name from ACCOUNTS_BOOTSTRAP_DATABASE_URL>');
  }
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 15000 });
  try {
    const result = await bootstrapFreshAccountsDatabase(pool, {
      stubSupabaseAuth: process.argv.includes('--stub-supabase-auth'),
    });
    console.info(
      `Fresh accounts bootstrap complete on ${database}: versions ${result.versions.join(',')}` +
        ` (base schemas pre-existed: ${result.baseSchemasPreexisted})`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
