import { Pool } from 'pg';
import { ensureDocumentSchema } from '@openmaic/storage/document/pg';
import { ensureAssetSchema } from '@openmaic/storage/asset/pg';
import { ensureAgentSessionSchema } from '@openmaic/storage/agent-session/pg';
import { ensureAgentSessionMaterialSchema } from '@openmaic/storage/material/pg';
import { ensureSchema } from '@openmaic/storage/runtime/pg';
import { ensureUserSkillSchema } from '@openmaic/storage/skill/pg';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import { ensureOwnerMaterialSchema } from '@/lib/persistence/owner-materials';
import { ensureStudySchema } from '@/lib/server/study/schema';
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
    // Study spaces (learning plan B01). Hosted databases also get row security
    // from accounts v22; legacy background installs only run this command.
    await ensureStudySchema(pool);
    // Pro generation and its material scanner share this worker process. A
    // fresh deployment must provision their durable stores before either
    // scanner starts; lazy Web initialization is too late for the worker.
    await ensureAgentSessionSchema(pool);
    await ensureAgentSessionMaterialSchema(pool);
    await ensureUserSkillSchema(pool);
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
