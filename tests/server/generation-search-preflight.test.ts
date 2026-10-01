import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Queryable } from '@openmaic/storage/document/pg';
import { GENERATION_MIGRATION_4 } from '@/lib/server/generation-jobs/migrations';
import { GenerationSearchSnapshotStore } from '@/lib/server/generation-search-snapshots';
import { parseGenerationInput } from '@/lib/server/generation-jobs/contracts';
import { validateBackgroundProviders } from '@/lib/server/generation-jobs/preflight';

vi.mock('@/lib/model-gateway', async (importOriginal) =>
  (await import('@/tests/helpers/model-gateway-mock')).mockGatewayModule(await importOriginal(), {
    resolveParamsBinding: vi.fn(async () => ({
      source: 'legacy-managed',
      providerId: 'openai',
      modelId: 'gpt-test',
      modelString: 'openai:gpt-test',
      credentialReady: true,
    })),
  }),
);
vi.mock('@/lib/server/provider-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/provider-config')>()),
  getServerProviders: () => ({ openai: { models: ['gpt-test'] } }),
  isServerConfiguredProvider: () => false,
  getServerWebSearchProviders: () => ({}),
  isServerProviderDisabled: () => false,
  resolveServerWebSearchProviderId: () => undefined,
  resolveWebSearchApiKey: (_id: string, key?: string) => key ?? '',
  resolveWebSearchBaseUrl: (_id: string, url?: string) => url,
  resolveWebSearchModel: (_id: string, model?: string) => model,
}));

describe('owner search snapshots at the job preflight boundary', () => {
  let db: PGlite;
  let queryable: Queryable;
  let store: GenerationSearchSnapshotStore;

  beforeEach(async () => {
    vi.stubEnv('GENERATION_MODEL_ENCRYPTION_KEY', 'ab'.repeat(32));
    vi.stubEnv('ASSET_S3_BUCKET', '');
    db = new PGlite();
    await db.exec(
      `CREATE TABLE generation_jobs(owner_id TEXT, status TEXT, input_snapshot JSONB); ${GENERATION_MIGRATION_4}`,
    );
    queryable = { query: (sql, values) => db.query(sql, values ? [...values] : []) };
    store = new GenerationSearchSnapshotStore(queryable);
  });
  afterEach(async () => {
    await db.close();
    vi.unstubAllEnvs();
  });

  it('accepts ordinary-mode search from an owner snapshot when no server search provider exists', async () => {
    const searchConfigRef = await store.create('owner-a', {
      version: 1,
      providerId: 'bocha',
      apiKey: 'owner-search-secret',
    });
    const input = parseGenerationInput({
      version: 1,
      requirements: { requirement: '学习布迪厄的思想', webSearch: true },
      webSearch: { providerId: 'bocha' },
      searchConfigRef,
      source: { kind: 'home' },
    });
    await expect(
      validateBackgroundProviders(input, { ownerId: 'owner-a', queryable }),
    ).resolves.toBeUndefined();
    expect(JSON.stringify(input)).not.toContain('owner-search-secret');
  });

  it('accepts the built-in Brave web search with no API key or server search provider', async () => {
    const searchConfigRef = await store.create('owner-a', {
      version: 1,
      providerId: 'brave',
      baseUrl: 'https://search.brave.com',
    });
    const input = parseGenerationInput({
      version: 1,
      requirements: { requirement: '布迪厄思想学习', webSearch: true },
      enableWebSearch: true,
      webSearch: { providerId: 'brave' },
      searchConfigRef,
    });
    await expect(
      validateBackgroundProviders(input, { ownerId: 'owner-a', queryable }),
    ).resolves.toBeUndefined();
  });

  it('rejects another owner, missing context and a mismatched provider or model', async () => {
    const searchConfigRef = await store.create('owner-a', {
      version: 1,
      providerId: 'bocha',
      apiKey: 'owner-search-secret',
    });
    const input = parseGenerationInput({
      version: 1,
      requirements: { requirement: 'test', webSearch: true },
      webSearch: { providerId: 'bocha' },
      searchConfigRef,
    });
    await expect(validateBackgroundProviders(input)).rejects.toThrow(
      'BACKGROUND_SEARCH_PROVIDER_UNAVAILABLE',
    );
    await expect(
      validateBackgroundProviders(input, { ownerId: 'owner-b', queryable }),
    ).rejects.toThrow('BACKGROUND_SEARCH_PROVIDER_UNAVAILABLE');
    for (const webSearch of [
      { providerId: 'brave' },
      { providerId: 'bocha', modelId: 'changed' },
    ]) {
      await expect(
        validateBackgroundProviders({ ...input, webSearch }, { ownerId: 'owner-a', queryable }),
      ).rejects.toThrow('BACKGROUND_SEARCH_PROVIDER_UNAVAILABLE');
    }
  });

  it('preserves the server-only search requirement for legacy jobs without a snapshot', async () => {
    const legacy = parseGenerationInput({
      version: 1,
      requirements: { requirement: 'test', webSearch: true },
      webSearch: { providerId: 'brave' },
      source: { kind: 'pro' },
    });
    await expect(
      validateBackgroundProviders(legacy, { ownerId: 'owner-a', queryable }),
    ).rejects.toThrow('BACKGROUND_SEARCH_PROVIDER_UNAVAILABLE');
  });
});
