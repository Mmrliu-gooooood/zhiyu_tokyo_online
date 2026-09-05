import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDocumentSchema } from '@openmaic/storage/document/pg';
import { ensureAssetSchema } from '@openmaic/storage/asset/pg';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import { migrateGenerationSchema } from '@/lib/server/generation-jobs/migrations';
import { GenerationJobRepository } from '@/lib/server/generation-jobs/repository';
import { PostgresGenerationLimiter } from '@/lib/server/generation-jobs/limiter';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';

const enabled = !!process.env.TEST_GENERATION_DATABASE_URL;
/** Operator-supplied isolated test DB only. Never uses DATABASE_URL or drops a public schema. */
describe.skipIf(!enabled)('generation PostgreSQL concurrency and row fences', () => {
  let admin: Pool, pool: Pool, repo: GenerationJobRepository;
  const schema = `generation_test_${randomUUID().replaceAll('-', '')}`;
  const input = {
    version: 1,
    requirements: { requirement: 'Concurrency test' },
    review: { mode: 'manual' },
  };
  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.TEST_GENERATION_DATABASE_URL, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({
      connectionString: process.env.TEST_GENERATION_DATABASE_URL,
      max: 10,
      options: `-c search_path=${schema}`,
    });
    await ensureDocumentSchema(pool);
    await ensureStageMetaSchema(pool);
    await ensureAssetSchema(pool);
    await Promise.all([migrateGenerationSchema(pool), migrateGenerationSchema(pool)]);
    repo = new GenerationJobRepository(pool);
  }, 30_000);
  afterAll(async () => {
    await pool?.end();
    // Test-only randomly named schema created above; public and existing objects are untouched.
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });
  it('same owner/key parallel creates commit one job and one course', async () => {
    const owner = randomUUID();
    const jobs = await Promise.all(
      Array.from({ length: 8 }, () => repo.createJob(owner, 'same', input)),
    );
    expect(new Set(jobs.map((j) => j.jobId)).size).toBe(1);
    const count = await pool.query(
      'SELECT count(*)::int n FROM document_stages WHERE owner_id=$1',
      [owner],
    );
    expect(count.rows[0].n).toBe(1);
    await repo.cancel(owner, jobs[0].jobId, { commandKey: 'end' });
  });
  it('queue limit and active-owner limit withstand parallel transactions', async () => {
    const owner = randomUUID();
    const limited = new GenerationJobRepository(pool, { maxQueuedPerOwner: 2 });
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => limited.createJob(owner, `q${i}`, input)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    const claims = await Promise.all(
      Array.from({ length: 6 }, (_, i) => limited.claim(`worker-${i}`)),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    const rows = await pool.query('SELECT id FROM generation_jobs WHERE owner_id=$1', [owner]);
    for (const row of rows.rows) await repo.cancel(owner, row.id, { commandKey: 'end' });
  });
  it('a locked job is skipped by a competing claimant', async () => {
    const owner = randomUUID(),
      job = await repo.createJob(owner, 'locked', input);
    const lock = await pool.connect();
    await lock.query('BEGIN');
    await lock.query('SELECT id FROM generation_jobs WHERE id=$1 FOR UPDATE', [job.jobId]);
    try {
      expect(await repo.claim('competitor')).toBeNull();
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
    }
    expect((await repo.claim('winner'))?.jobId).toBe(job.jobId);
    await repo.cancel(owner, job.jobId, { commandKey: 'end' });
  });
  it('cancel wins before queued commit obtains the job lock, no late checkpoint survives', async () => {
    const owner = randomUUID(),
      job = await repo.createJob(owner, 'race', input),
      lease = (await repo.claim('racer'))!;
    await repo.beginStep(lease, { key: 'content', kind: 'content', dependencyHash: 'x' });
    const lock = await pool.connect();
    await lock.query('BEGIN');
    await lock.query(
      "UPDATE generation_jobs SET status='cancelled',lease_epoch=lease_epoch+1 WHERE id=$1",
      [job.jobId],
    );
    const commit = repo.commitCheckpoint(lease, { stepKey: 'content', result: 'late' });
    await lock.query('COMMIT');
    lock.release();
    await expect(commit).rejects.toThrow('STALE_GENERATION_LEASE');
    const stored = await pool.query('SELECT result FROM generation_steps WHERE job_id=$1', [
      job.jobId,
    ]);
    expect(stored.rows[0].result).toBeNull();
  });
  it('delete and worker result commits serialize without stale ownership writes', async () => {
    const owner = randomUUID(),
      job = await repo.createJob(owner, 'delete', input),
      lease = (await repo.claim('deleting'))!;
    await repo.beginStep(lease, { key: 'checkpoint', kind: 'prepare', dependencyHash: 'x' });
    const store = createOwnerBoundDocumentStore({
      pool,
      ownerId: owner,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    });
    await store.deleteDocument(job.stageId);
    await expect(
      repo.commitCheckpoint(lease, { stepKey: 'checkpoint', result: 'late' }),
    ).rejects.toThrow('STALE_GENERATION_LEASE');
    expect((await repo.getJob(owner, job.jobId))?.status).toBe('cancelled');
  });
  it('multiple limiter instances never allocate more slots than the DB quota', async () => {
    const group = `llm:${randomUUID()}`,
      a = new PostgresGenerationLimiter(pool),
      b = new PostgresGenerationLimiter(pool);
    const slots = await Promise.all(
      Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).acquire(group, 3)),
    );
    expect(slots.filter(Boolean)).toHaveLength(3);
    for (const slot of slots) if (slot) await a.release(slot);
  });
});
