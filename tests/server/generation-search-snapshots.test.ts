import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateGenerationSchema } from '@/lib/server/generation-jobs/migrations';
import { GenerationJobRepository } from '@/lib/server/generation-jobs/repository';
import { ensureDocumentSchema } from '@openmaic/storage/document/pg';
import { ensureAssetSchema } from '@openmaic/storage/asset/pg';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import {
  GenerationSearchSnapshotStore,
  type GenerationSearchSnapshotContent,
} from '@/lib/server/generation-search-snapshots';

describe('generation search snapshots', () => {
  let db: PGlite;
  let pool: TestPool;
  const owner = 'owner-a';
  const content: GenerationSearchSnapshotContent = {
    version: 1,
    providerId: 'tavily',
    apiKey: 'private-key',
    baseUrl: 'https://api.tavily.com',
  };

  beforeEach(async () => {
    vi.stubEnv('GENERATION_MODEL_ENCRYPTION_KEY', '11'.repeat(32));
    db = new PGlite();
    await db.waitReady;
    pool = new TestPool(db);
    await ensureDocumentSchema(pool);
    await ensureStageMetaSchema(pool);
    await ensureAssetSchema(pool);
    await migrateGenerationSchema(pool);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.close();
  });

  it('stores only ciphertext and resolves an opaque ref for its owner', async () => {
    const store = new GenerationSearchSnapshotStore(pool);
    const ref = await store.create(owner, content);
    expect(ref).toMatchObject({ revision: 1 });
    expect(await store.load(owner, ref)).toEqual(content);
    await expect(store.load('owner-b', ref)).rejects.toThrow(
      'GENERATION_SEARCH_SNAPSHOT_UNAVAILABLE',
    );

    const row = await pool.query<{ ciphertext: string }>(
      'SELECT ciphertext FROM generation_search_snapshots WHERE id=$1',
      [ref.id],
    );
    expect(row.rows[0]?.ciphertext).not.toContain('private-key');
  });

  it('does not let a foreign owner revoke a snapshot', async () => {
    const store = new GenerationSearchSnapshotStore(pool);
    const ref = await store.create(owner, content);

    await expect(store.revoke('owner-b', ref)).resolves.toBe(false);
    await expect(store.load(owner, ref)).resolves.toEqual(content);
  });

  it('deduplicates unchanged intent only within the same owner', async () => {
    const store = new GenerationSearchSnapshotStore(pool);
    const ref = await store.create(owner, content);
    expect(await store.create(owner, content)).toEqual(ref);
    expect(await store.create('owner-b', content)).not.toEqual(ref);
    expect(await store.create(owner, { ...content, apiKey: 'replacement-key' })).not.toEqual(ref);
  });

  it('authenticates encrypted payloads against their owner and reference', async () => {
    const store = new GenerationSearchSnapshotStore(pool);
    const first = await store.create(owner, content);
    const second = await store.create(owner, { ...content, apiKey: 'replacement-key' });
    await pool.query(
      'UPDATE generation_search_snapshots SET ciphertext=(SELECT ciphertext FROM generation_search_snapshots WHERE id=$1) WHERE id=$2',
      [first.id, second.id],
    );
    await expect(store.load(owner, second)).rejects.toMatchObject({
      code: 'GENERATION_SEARCH_DECRYPTION_FAILED',
    });
  });

  it('revokes an unreferenced owner snapshot and removes its expired ciphertext', async () => {
    const store = new GenerationSearchSnapshotStore(pool);
    const ref = await store.create(owner, content);

    await expect(store.revoke(owner, ref)).resolves.toBe(true);
    await expect(store.load(owner, ref)).rejects.toMatchObject({
      code: 'GENERATION_SEARCH_SNAPSHOT_UNAVAILABLE',
    });
    await pool.query(
      "UPDATE generation_search_snapshots SET revoked_at=clock_timestamp()-interval '2 days' WHERE id=$1",
      [ref.id],
    );

    await expect(store.cleanupExpired(86_400_000)).resolves.toEqual({ revoked: 0, deleted: 1 });
    expect(
      (await pool.query('SELECT id FROM generation_search_snapshots WHERE id=$1', [ref.id])).rows,
    ).toHaveLength(0);
  });

  it('collects an expired orphan left when job submission never references the API snapshot', async () => {
    const store = new GenerationSearchSnapshotStore(pool);
    const ref = await store.create(owner, content);
    await pool.query(
      "UPDATE generation_search_snapshots SET created_at=clock_timestamp()-interval '2 days' WHERE id=$1",
      [ref.id],
    );

    await expect(store.cleanupExpired(86_400_000)).resolves.toEqual({ revoked: 1, deleted: 0 });
    await expect(store.load(owner, ref)).rejects.toMatchObject({
      code: 'GENERATION_SEARCH_SNAPSHOT_UNAVAILABLE',
    });
    expect(
      (
        await pool.query(
          "SELECT id FROM generation_jobs WHERE input_snapshot->'searchConfigRef'->>'id'=$1",
          [ref.id],
        )
      ).rows,
    ).toHaveLength(0);
  });

  it('loads a revoked snapshot for a nonterminal job created by a preflight race', async () => {
    const store = new GenerationSearchSnapshotStore(pool);
    const ref = await store.create(owner, content);
    await expect(store.revoke(owner, ref)).resolves.toBe(true);
    const repository = new GenerationJobRepository(pool);
    const job = await repository.createJob(owner, 'raced-model-snapshot', {
      version: 1,
      requirements: { requirement: 'Test preflight race retention' },
      review: { mode: 'manual' },
      searchConfigRef: ref,
    });
    expect(await repository.claim('worker-a')).toMatchObject({ jobId: job.jobId });

    await expect(store.load(owner, ref)).resolves.toEqual(content);
  });

  it('keeps a snapshot available while a nonterminal job references it', async () => {
    const store = new GenerationSearchSnapshotStore(pool);
    const ref = await store.create(owner, content);
    const repository = new GenerationJobRepository(pool);
    const job = await repository.createJob(owner, 'active-model-snapshot', {
      version: 1,
      requirements: { requirement: 'Test active retention' },
      review: { mode: 'manual' },
      searchConfigRef: ref,
    });
    expect(await repository.claim('worker-a')).toMatchObject({ jobId: job.jobId });

    await expect(store.revoke(owner, ref)).resolves.toBe(false);
    await expect(store.load(owner, ref)).resolves.toEqual(content);
  });

  it('deletes a snapshot only after every referencing job is terminal and past retention', async () => {
    const store = new GenerationSearchSnapshotStore(pool);
    const ref = await store.create(owner, content);
    const repository = new GenerationJobRepository(pool);
    const job = await repository.createJob(owner, 'terminal-model-snapshot', {
      version: 1,
      requirements: { requirement: 'Test terminal retention' },
      review: { mode: 'manual' },
      searchConfigRef: ref,
    });
    expect(await repository.claim('worker-a')).toMatchObject({ jobId: job.jobId });
    await pool.query(
      "UPDATE generation_jobs SET status='succeeded',finished_at=clock_timestamp() WHERE id=$1",
      [job.jobId],
    );

    await expect(store.cleanupExpired(86_400_000)).resolves.toEqual({ revoked: 0, deleted: 0 });
    await expect(store.load(owner, ref)).resolves.toEqual(content);

    await pool.query(
      "UPDATE generation_jobs SET finished_at=clock_timestamp()-interval '2 days' WHERE id=$1",
      [job.jobId],
    );
    await expect(store.cleanupExpired(86_400_000)).resolves.toEqual({ revoked: 1, deleted: 0 });
    await expect(store.load(owner, ref)).rejects.toMatchObject({
      code: 'GENERATION_SEARCH_SNAPSHOT_UNAVAILABLE',
    });
    await pool.query(
      "UPDATE generation_search_snapshots SET revoked_at=clock_timestamp()-interval '2 days' WHERE id=$1",
      [ref.id],
    );
    await expect(store.cleanupExpired(86_400_000)).resolves.toEqual({ revoked: 0, deleted: 1 });
  });
});

class TestPool {
  constructor(readonly db: PGlite) {}
  query<R extends Record<string, unknown>>(sql: string, args?: unknown[]) {
    return this.db.query<R>(sql, args);
  }
  async connect() {
    return { query: (sql: string, args?: unknown[]) => this.db.query(sql, args), release() {} };
  }
}
