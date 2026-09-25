import { Pool } from 'pg';

import { migrateAccountsSchema } from '../lib/server/accounts/migrations';
import {
  hostedPgPool,
  isHostedDbHost,
  loadHostedOperatorEnv,
} from './lib/hosted-operator-env';

async function main() {
  loadHostedOperatorEnv();
  const connectionString =
    process.env.GENERATION_MIGRATION_DATABASE_URL?.trim() ||
    process.env.HOSTED_DB_ADMIN_URL?.trim() ||
    process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error('DATABASE_URL, HOSTED_DB_ADMIN_URL, or GENERATION_MIGRATION_DATABASE_URL is required');
  }
  let hostedHost = false;
  try {
    hostedHost = isHostedDbHost(new URL(connectionString).hostname);
  } catch {
    hostedHost = false;
  }
  const pool = hostedHost ? hostedPgPool(connectionString) : new Pool({ connectionString });
  try {
    await migrateAccountsSchema(pool);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
