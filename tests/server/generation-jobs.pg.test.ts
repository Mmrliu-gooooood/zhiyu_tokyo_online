import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ensureDocumentSchema } from '@openmaic/storage/document/pg';
import { ensureAssetSchema } from '@openmaic/storage/asset/pg';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import { migrateGenerationSchema } from '@/lib/server/generation-jobs/migrations';
import { GenerationJobRepository } from '@/lib/server/generation-jobs/repository';
import { PostgresGenerationLimiter } from '@/lib/server/generation-jobs/limiter';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';

const enabled = !!process.env.TEST_GENERATION_DATABASE_URL;
let claimFixturePath = '';
let claimFixtureDirectory = '';

async function runClaimProcess(schema: string, workerId: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [claimFixturePath, schema, workerId], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        APP_HEAVY_TASK_LIMIT: '16',
        APP_HEAVY_TASK_PER_OWNER_LIMIT: '2',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`claim process exited ${code}: ${stderr.slice(-4000)}`));
        return;
      }
      try {
        resolve((JSON.parse(stdout.trim()) as { claimed: string[] }).claimed);
      } catch (error) {
        reject(error);
      }
    });
  });
}
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
    claimFixtureDirectory = await mkdtemp(path.join(tmpdir(), 'openmaic-generation-claim-'));
    claimFixturePath = path.join(claimFixtureDirectory, 'generation-claim-process.cjs');
    // Bundle once before the two real Node processes start. Concurrent tsx transforms
    // on Node 24 can race in their source-map cache and surface a parser error that is
    // unrelated to PostgreSQL concurrency; the child processes themselves remain real.
    await build({
      entryPoints: [path.resolve('tests/server/fixtures/generation-claim-process.ts')],
      outfile: claimFixturePath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      sourcemap: false,
      tsconfig: path.resolve('tsconfig.json'),
    });
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
    if (claimFixtureDirectory) {
      await rm(claimFixtureDirectory, { recursive: true, force: true });
    }
  });
  afterEach(async () => {
    // Keep failures in one concurrency scenario from lending leases or queue rows
    // to the next scenario. The schema is random and test-only; persisted result
    // rows remain available during each assertion and are discarded in afterAll.
    await pool.query(
      `UPDATE generation_jobs
          SET status='cancelled', worker_id=NULL, lease_epoch=lease_epoch+1,
              lease_expires_at=NULL, heartbeat_at=NULL
        WHERE status NOT IN ('succeeded','failed','cancelled')`,
    );
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
  it('queue limit and 16/2 active-owner limit withstand parallel transactions', async () => {
    const owner = randomUUID();
    const limited = new GenerationJobRepository(pool, { maxQueuedPerOwner: 2 });
    const previousSiteLimit = process.env.APP_HEAVY_TASK_LIMIT;
    const previousOwnerLimit = process.env.APP_HEAVY_TASK_PER_OWNER_LIMIT;
    process.env.APP_HEAVY_TASK_LIMIT = '16';
    process.env.APP_HEAVY_TASK_PER_OWNER_LIMIT = '2';
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) => limited.createJob(owner, `q${i}`, input)),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
      const claims = await Promise.all(
        Array.from({ length: 6 }, (_, i) => limited.claim(`worker-${i}`)),
      );
      expect(claims.filter(Boolean)).toHaveLength(2);
      const rows = await pool.query('SELECT id FROM generation_jobs WHERE owner_id=$1', [owner]);
      for (const row of rows.rows) await repo.cancel(owner, row.id, { commandKey: 'end' });
    } finally {
      if (previousSiteLimit === undefined) delete process.env.APP_HEAVY_TASK_LIMIT;
      else process.env.APP_HEAVY_TASK_LIMIT = previousSiteLimit;
      if (previousOwnerLimit === undefined) delete process.env.APP_HEAVY_TASK_PER_OWNER_LIMIT;
      else process.env.APP_HEAVY_TASK_PER_OWNER_LIMIT = previousOwnerLimit;
    }
  });
  it('two worker processes cap eight owners at 16 roots and leave the seventeenth queued', async () => {
    const owners = Array.from({ length: 9 }, () => randomUUID());
    const jobs: Array<{ ownerId: string; jobId: string }> = [];
    for (const [ownerIndex, owner] of owners.entries()) {
      const count = ownerIndex < 8 ? 2 : 1;
      for (let index = 0; index < count; index += 1) {
        const job = await repo.createJob(owner, `multiprocess-${ownerIndex}-${index}`, {
          ...input,
          review: { mode: 'auto' },
        });
        jobs.push({ ownerId: owner, jobId: job.jobId });
      }
    }

    const claimedByProcess = await Promise.all([
      runClaimProcess(schema, `process-a-${randomUUID()}`),
      runClaimProcess(schema, `process-b-${randomUUID()}`),
    ]);
    expect(new Set(claimedByProcess.flat()).size).toBe(16);
    const states = await pool.query<{ status: string; owner_id: string; count: number }>(
      `SELECT status, owner_id, count(*)::int AS count
         FROM generation_jobs WHERE id=ANY($1::uuid[])
        GROUP BY status, owner_id`,
      [jobs.map((job) => job.jobId)],
    );
    expect(states.rows.filter((row) => row.status === 'running')).toHaveLength(8);
    expect(
      states.rows.filter((row) => row.status === 'running').every((row) => row.count === 2),
    ).toBe(true);
    expect(states.rows.filter((row) => row.status === 'queued')).toEqual([
      expect.objectContaining({ owner_id: owners[8], count: 1 }),
    ]);

    for (const [ownerIndex, owner] of owners.entries()) {
      for (const job of jobs.filter((candidate) => candidate.ownerId === owner)) {
        await repo.cancel(owner, job.jobId, { commandKey: `end-${ownerIndex}-${job.jobId}` });
      }
    }
  }, 60_000);
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
