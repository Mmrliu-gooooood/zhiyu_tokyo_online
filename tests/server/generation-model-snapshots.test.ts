import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateGenerationSchema } from '@/lib/server/generation-jobs/migrations';
import { GenerationJobRepository } from '@/lib/server/generation-jobs/repository';
import { ensureDocumentSchema } from '@openmaic/storage/document/pg';
import { ensureAssetSchema } from '@openmaic/storage/asset/pg';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import {
  GenerationModelSnapshotStore,
  generationModelSnapshotContent,
  upgradeSnapshotContent,
  type GenerationModelSnapshotContent,
} from '@/lib/server/generation-model-snapshots';
import { CATALOG_VERSION } from '@/lib/model-gateway/catalog/client-catalog';
import { GATEWAY_VERSION } from '@/lib/model-gateway';
import { plantModelSnapshot } from '@/tests/helpers/legacy-model-snapshot';

describe('generation model snapshots', () => {
  let db: PGlite;
  let pool: TestPool;
  const owner = 'owner-a';
  const content: GenerationModelSnapshotContent = {
    version: 3,
    selection: {
      source: 'user',
      providerId: 'openai',
      modelId: 'gpt-test',
      connection: {
        auth: 'api-key',
        apiKey: 'private-key',
        baseUrl: 'https://api.example.com/v1',
        api: 'openai-completions',
      },
      thinking: { mode: 'disabled', effort: 'none' },
    },
    catalogVersion: CATALOG_VERSION,
    gatewayVersion: GATEWAY_VERSION,
  };

  it('writes v3 content: the gateway selection plus catalog and gateway versions', () => {
    expect(
      generationModelSnapshotContent({
        source: 'user',
        modelString: 'openai:gpt-test',
        apiKey: 'private-key',
        baseUrl: 'https://api.example.com/v1',
        providerType: 'openai',
        api: 'openai-completions',
        thinkingConfig: { mode: 'disabled', effort: 'none' },
      }),
    ).toEqual(content);
  });

  describe('upgradeSnapshotContent', () => {
    const legacy = { catalogVersion: 'legacy', gatewayVersion: 'legacy' };
    it('upgrades v1 (no source) to an operator-managed selection with its connection', () => {
      expect(
        upgradeSnapshotContent({
          version: 1,
          modelString: 'openai:gpt-test',
          apiKey: 'k1',
          providerType: 'openai',
          api: 'openai-completions',
          thinkingConfig: { effort: 'low' },
        }),
      ).toEqual({
        version: 3,
        selection: {
          source: 'legacy-managed',
          providerId: 'openai',
          modelId: 'gpt-test',
          connection: { auth: 'api-key', apiKey: 'k1', api: 'openai-completions' },
          thinking: { effort: 'low' },
        },
        ...legacy,
      });
    });
    it('upgrades v2 user content, mapping a custom provider type to its wire API', () => {
      expect(
        upgradeSnapshotContent({
          version: 2,
          source: 'user',
          modelString: 'custom-personal:my-model',
          apiKey: 'k2',
          baseUrl: 'https://models.example.test/v1',
          providerType: 'anthropic',
        }),
      ).toEqual({
        version: 3,
        selection: {
          source: 'user',
          providerId: 'custom-personal',
          modelId: 'my-model',
          connection: {
            auth: 'api-key',
            apiKey: 'k2',
            baseUrl: 'https://models.example.test/v1',
            api: 'anthropic-messages',
          },
        },
        ...legacy,
      });
    });
    it('upgrades v2 legacy-managed content without a connection when it carried none', () => {
      expect(
        upgradeSnapshotContent({
          version: 2,
          source: 'legacy-managed',
          modelString: 'deepseek:deepseek-chat',
        }),
      ).toEqual({
        version: 3,
        selection: { source: 'legacy-managed', providerId: 'deepseek', modelId: 'deepseek-chat' },
        ...legacy,
      });
    });
    it('upgrades v2 platform content keeping the pinned revision and thinking', () => {
      expect(
        upgradeSnapshotContent({
          version: 2,
          source: 'platform',
          defaultId: 'zhiyu-default-text',
          revision: 'text-r1',
          thinkingConfig: { effort: 'none' },
        }),
      ).toEqual({
        version: 3,
        selection: {
          source: 'platform',
          defaultId: 'zhiyu-default-text',
          revision: 'text-r1',
          thinking: { effort: 'none' },
        },
        ...legacy,
      });
    });
    it('returns v3 content unchanged', () => {
      expect(upgradeSnapshotContent(content)).toBe(content);
    });
  });

  it('rejects a v3 platform selection without a pinned revision', () => {
    expect(() =>
      generationModelSnapshotContent({ source: 'platform', defaultId: 'zhiyu-default-text' }),
    ).toThrow('GENERATION_MODEL_INVALID');
  });

  it('serializes platform intent without provider credentials or concrete model ids', () => {
    expect(
      generationModelSnapshotContent({
        source: 'platform',
        defaultId: 'zhiyu-default-text',
        revision: 'text-r1',
        modelString: 'deepseek:must-not-leak',
        apiKey: 'must-not-leak',
        baseUrl: 'https://must-not-leak.example.com',
        thinkingConfig: { mode: 'disabled', effort: 'none' },
      }),
    ).toEqual({
      version: 3,
      selection: {
        source: 'platform',
        defaultId: 'zhiyu-default-text',
        revision: 'text-r1',
        thinking: { mode: 'disabled', effort: 'none' },
      },
      catalogVersion: CATALOG_VERSION,
      gatewayVersion: GATEWAY_VERSION,
    });
  });

  it('rejects non-text platform defaults at the text model snapshot boundary', () => {
    expect(() =>
      generationModelSnapshotContent({
        source: 'platform',
        defaultId: 'zhiyu-default-image',
        revision: 'image-r1',
      }),
    ).toThrow('GENERATION_MODEL_INVALID');
  });

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
    const store = new GenerationModelSnapshotStore(pool);
    const ref = await store.create(owner, content);
    expect(ref).toMatchObject({ revision: 1 });
    expect(await store.load(owner, ref)).toEqual(content);
    await expect(store.load('owner-b', ref)).rejects.toThrow(
      'GENERATION_MODEL_SNAPSHOT_UNAVAILABLE',
    );

    const row = await pool.query<{ ciphertext: string }>(
      'SELECT ciphertext FROM generation_model_snapshots WHERE id=$1',
      [ref.id],
    );
    expect(row.rows[0]?.ciphertext).not.toContain('private-key');
  });

  it('continues to load platform v2 snapshots created before thinking policy was added', async () => {
    const store = new GenerationModelSnapshotStore(pool);
    const ref = await plantModelSnapshot(pool, owner, {
      version: 2,
      source: 'platform',
      defaultId: 'zhiyu-default-text',
      revision: 'text-r1',
    });

    await expect(store.load(owner, ref)).resolves.toEqual({
      version: 3,
      selection: { source: 'platform', defaultId: 'zhiyu-default-text', revision: 'text-r1' },
      catalogVersion: 'legacy',
      gatewayVersion: 'legacy',
    });
  });

  it('loads v1 rows through the upgrader and writes only v3', async () => {
    const store = new GenerationModelSnapshotStore(pool);
    const ref = await plantModelSnapshot(pool, owner, {
      version: 1,
      modelString: 'openai:gpt-test',
      apiKey: 'private-key',
    });
    await expect(store.load(owner, ref)).resolves.toMatchObject({
      version: 3,
      selection: {
        source: 'legacy-managed',
        connection: { auth: 'api-key', apiKey: 'private-key' },
      },
    });
    await expect(
      store.create(owner, { version: 1, modelString: 'openai:gpt-test', apiKey: 'k' }),
    ).rejects.toMatchObject({ code: 'GENERATION_MODEL_INVALID' });
    const created = await store.create(owner, content);
    const row = await pool.query<{ schema_version: number }>(
      'SELECT schema_version FROM generation_model_snapshots WHERE id=$1',
      [created.id],
    );
    expect(row.rows[0]?.schema_version).toBe(3);
  });

  it('does not let a foreign owner revoke a snapshot', async () => {
    const store = new GenerationModelSnapshotStore(pool);
    const ref = await store.create(owner, content);

    await expect(store.revoke('owner-b', ref)).resolves.toBe(false);
    await expect(store.load(owner, ref)).resolves.toEqual(content);
  });

  it('revokes an unreferenced owner snapshot and removes its expired ciphertext', async () => {
    const store = new GenerationModelSnapshotStore(pool);
    const ref = await store.create(owner, content);

    await expect(store.revoke(owner, ref)).resolves.toBe(true);
    await expect(store.load(owner, ref)).rejects.toMatchObject({
      code: 'GENERATION_MODEL_SNAPSHOT_UNAVAILABLE',
    });
    await pool.query(
      "UPDATE generation_model_snapshots SET revoked_at=clock_timestamp()-interval '2 days' WHERE id=$1",
      [ref.id],
    );

    await expect(store.cleanupExpired(86_400_000)).resolves.toEqual({ revoked: 0, deleted: 1 });
    expect(
      (await pool.query('SELECT id FROM generation_model_snapshots WHERE id=$1', [ref.id])).rows,
    ).toHaveLength(0);
  });

  it('collects an expired orphan left when job submission never references the API snapshot', async () => {
    const store = new GenerationModelSnapshotStore(pool);
    const ref = await store.create(owner, content);
    await pool.query(
      "UPDATE generation_model_snapshots SET created_at=clock_timestamp()-interval '2 days' WHERE id=$1",
      [ref.id],
    );

    await expect(store.cleanupExpired(86_400_000)).resolves.toEqual({ revoked: 1, deleted: 0 });
    await expect(store.load(owner, ref)).rejects.toMatchObject({
      code: 'GENERATION_MODEL_SNAPSHOT_UNAVAILABLE',
    });
    expect(
      (
        await pool.query(
          "SELECT id FROM generation_jobs WHERE input_snapshot->'modelConfigRef'->>'id'=$1",
          [ref.id],
        )
      ).rows,
    ).toHaveLength(0);
  });

  it('loads a revoked snapshot for a nonterminal job created by a preflight race', async () => {
    const store = new GenerationModelSnapshotStore(pool);
    const ref = await store.create(owner, content);
    await expect(store.revoke(owner, ref)).resolves.toBe(true);
    const repository = new GenerationJobRepository(pool);
    const job = await repository.createJob(owner, 'raced-model-snapshot', {
      version: 1,
      requirements: { requirement: 'Test preflight race retention' },
      review: { mode: 'manual' },
      modelConfigRef: ref,
    });
    expect(await repository.claim('worker-a')).toMatchObject({ jobId: job.jobId });

    await expect(store.load(owner, ref)).resolves.toEqual(content);
  });

  it('keeps a snapshot available while a nonterminal job references it', async () => {
    const store = new GenerationModelSnapshotStore(pool);
    const ref = await store.create(owner, content);
    const repository = new GenerationJobRepository(pool);
    const job = await repository.createJob(owner, 'active-model-snapshot', {
      version: 1,
      requirements: { requirement: 'Test active retention' },
      review: { mode: 'manual' },
      modelConfigRef: ref,
    });
    expect(await repository.claim('worker-a')).toMatchObject({ jobId: job.jobId });

    await expect(store.revoke(owner, ref)).resolves.toBe(false);
    await expect(store.load(owner, ref)).resolves.toEqual(content);
  });

  it('deletes a snapshot only after every referencing job is terminal and past retention', async () => {
    const store = new GenerationModelSnapshotStore(pool);
    const ref = await store.create(owner, content);
    const repository = new GenerationJobRepository(pool);
    const job = await repository.createJob(owner, 'terminal-model-snapshot', {
      version: 1,
      requirements: { requirement: 'Test terminal retention' },
      review: { mode: 'manual' },
      modelConfigRef: ref,
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
      code: 'GENERATION_MODEL_SNAPSHOT_UNAVAILABLE',
    });
    await pool.query(
      "UPDATE generation_model_snapshots SET revoked_at=clock_timestamp()-interval '2 days' WHERE id=$1",
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
