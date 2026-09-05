import { Pool } from 'pg';
import { ensureDocumentSchema } from '@openmaic/storage/document/pg';
import { ensureAssetSchema } from '@openmaic/storage/asset/pg';
import { ensureSchema } from '@openmaic/storage/runtime/pg';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import { ensureOwnerMaterialSchema } from '@/lib/persistence/owner-materials';
import { migrateGenerationSchema } from '@/lib/server/generation-jobs/migrations';

async function main() {
  const connectionString =
    process.env.GENERATION_MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error('Migration connection is required');
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
  try {
    // Existing persistence bootstrap is invoked explicitly by this administrative
    // command so a fresh database also receives the additive base schemas.
    await ensureSchema(pool);
    await ensureDocumentSchema(pool);
    await ensureStageMetaSchema(pool);
    await ensureOwnerMaterialSchema(pool);
    await ensureAssetSchema(pool);
    await migrateGenerationSchema(pool);
    console.info('Generation schema migration complete');
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  console.error('Generation migration failed; database details suppressed');
  process.exitCode = 1;
});
