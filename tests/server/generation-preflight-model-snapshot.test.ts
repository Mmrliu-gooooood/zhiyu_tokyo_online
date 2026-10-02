import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Queryable } from '@openmaic/storage/document/pg';

const state = vi.hoisted(() => ({
  managed: {} as Record<string, { models?: string[]; apiKey?: string }>,
}));
vi.mock('@/lib/server/provider-config', () => ({
  PlatformDefaultModelError: class PlatformDefaultModelError extends Error {},
  getServerProviders: () => state.managed,
  getServerTTSProviders: () => ({}),
  getServerImageProviders: () => ({}),
  getServerVideoProviders: () => ({}),
  getServerWebSearchProviders: () => ({}),
  isServerProviderDisabled: () => false,
  isServerConfiguredProvider: (_section: string, id: string) => !!state.managed[id],
  resolveApiKey: (id: string, client?: string) =>
    state.managed[id] ? state.managed[id].apiKey || '' : client || '',
  resolveBaseUrl: (id: string, client?: string) => (state.managed[id] ? undefined : client),
  resolveProxy: () => undefined,
}));
vi.mock('@/lib/server/ssrf-guard', () => ({ validateUrlForSSRF: async () => null }));

import {
  GenerationModelSnapshotStore,
  generationModelSnapshotContent,
} from '@/lib/server/generation-model-snapshots';
import { plantModelSnapshot } from '@/tests/helpers/legacy-model-snapshot';
import { GENERATION_MIGRATION_3 } from '@/lib/server/generation-jobs/migrations';
import { parseGenerationInput } from '@/lib/server/generation-jobs/contracts';
import type { validateBackgroundProviders } from '@/lib/server/generation-jobs/preflight';

describe('background model snapshot preflight with real model resolution', () => {
  let db: PGlite;
  let queryable: Queryable;
  let store: GenerationModelSnapshotStore;

  beforeEach(async () => {
    vi.resetModules();
    state.managed = {};
    vi.stubEnv('GENERATION_MODEL_ENCRYPTION_KEY', 'cd'.repeat(32));
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('DEFAULT_MODEL', '');
    vi.stubEnv('MODEL_ROUTES', '');
    db = new PGlite();
    await db.exec(`
      CREATE TABLE generation_jobs(owner_id TEXT, status TEXT, input_snapshot JSONB);
      ${GENERATION_MIGRATION_3}
    `);
    queryable = { query: (sql, values) => db.query(sql, values ? [...values] : []) };
    store = new GenerationModelSnapshotStore(queryable);
  });
  afterEach(async () => {
    await db.close();
    vi.unstubAllEnvs();
  });

  async function input(modelString = 'openai:gpt-4.1', apiKey = 'owner-key') {
    const modelConfigRef = await store.create(
      'owner-a',
      generationModelSnapshotContent({
        modelString,
        apiKey,
        providerType: 'openai',
        baseUrl: 'https://models.example.test/v1',
      }),
    );
    return parseGenerationInput({
      version: 1,
      requirements: { requirement: 'Course' },
      model: { modelString },
      modelConfigRef,
    });
  }
  const validate = async (
    value: Parameters<typeof validateBackgroundProviders>[0],
    ownerId = 'owner-a',
  ) => {
    const { validateBackgroundProviders } = await import('@/lib/server/generation-jobs/preflight');
    return validateBackgroundProviders(value, { ownerId, queryable });
  };

  it.each(['openai:gpt-4.1', 'custom-personal:my-model'])(
    'accepts the owner encrypted client model %s with an empty server provider list',
    async (modelString) => {
      await expect(validate(await input(modelString))).resolves.toBeUndefined();
    },
  );

  it('accepts a v1 snapshot written before model sources existed', async () => {
    const modelConfigRef = await plantModelSnapshot(queryable, 'owner-a', {
      version: 1,
      modelString: 'openai:gpt-4.1',
      apiKey: 'owner-key',
      providerType: 'openai',
      baseUrl: 'https://models.example.test/v1',
    });
    const value = parseGenerationInput({
      version: 1,
      requirements: { requirement: 'Course' },
      model: { modelString: 'openai:gpt-4.1' },
      modelConfigRef,
    });
    await expect(validate(value)).resolves.toBeUndefined();
  });

  it('rejects an unmanaged model without its encrypted snapshot', async () => {
    const value = await input();
    delete value.modelConfigRef;
    await expect(validate(value)).rejects.toThrow('BACKGROUND_MODEL_PROVIDER_UNAVAILABLE');
  });

  it('rejects an input model that does not match the encrypted snapshot', async () => {
    state.managed.openai = { apiKey: 'server-key' };
    const value = await input();
    value.model = { modelString: 'openai:gpt-4.1-mini' };
    await expect(validate(value)).rejects.toThrow('BACKGROUND_MODEL_PROVIDER_UNAVAILABLE');
  });

  it('rejects a user input paired with a legacy-managed snapshot for the same model', async () => {
    const modelConfigRef = await plantModelSnapshot(queryable, 'owner-a', {
      version: 2,
      source: 'legacy-managed',
      modelString: 'openai:gpt-4.1',
      apiKey: 'owner-key',
      providerType: 'openai',
    });
    const value = parseGenerationInput({
      version: 1,
      requirements: { requirement: 'Course' },
      model: { source: 'user', modelString: 'openai:gpt-4.1' },
      modelConfigRef,
    });

    await expect(validate(value)).rejects.toThrow('BACKGROUND_MODEL_PROVIDER_UNAVAILABLE');
  });

  it('accepts an opaque-only Pro model reference without requiring a duplicate model field', async () => {
    const value = await input();
    delete value.model;
    await expect(validate(value)).resolves.toBeUndefined();
  });

  it('rejects a missing required client key and owner mismatch', async () => {
    await expect(validate(await input('openai:gpt-4.1', ''))).rejects.toThrow(
      'BACKGROUND_MODEL_PROVIDER_UNAVAILABLE',
    );
    await expect(validate(await input(), 'owner-b')).rejects.toThrow(
      'BACKGROUND_MODEL_PROVIDER_UNAVAILABLE',
    );
  });

  it('keeps the server model allowlist and credentials authoritative', async () => {
    state.managed.openai = { models: ['gpt-4.1-mini'], apiKey: 'server-key' };
    await expect(validate(await input())).rejects.toThrow('BACKGROUND_MODEL_PROVIDER_UNAVAILABLE');
    state.managed.openai = { models: ['gpt-4.1'], apiKey: '' };
    await expect(validate(await input())).rejects.toThrow('BACKGROUND_MODEL_PROVIDER_UNAVAILABLE');
    state.managed.openai.apiKey = 'server-key';
    await expect(validate(await input())).resolves.toBeUndefined();
  });

  it('keeps configured stage routes authoritative with client snapshots', async () => {
    state.managed.anthropic = { apiKey: 'server-key', models: ['claude-sonnet-4'] };
    vi.stubEnv('MODEL_ROUTES', JSON.stringify({ 'scene-actions': 'anthropic:claude-sonnet-4' }));
    await expect(validate(await input())).resolves.toBeUndefined();
    state.managed.anthropic.apiKey = '';
    await expect(validate(await input())).rejects.toThrow('BACKGROUND_MODEL_PROVIDER_UNAVAILABLE');
  });

  it('does not authorize an unmanaged server route using a client snapshot for the same model', async () => {
    vi.stubEnv('MODEL_ROUTES', JSON.stringify({ 'scene-actions': 'openai:gpt-4.1' }));
    await expect(validate(await input())).rejects.toThrow('BACKGROUND_MODEL_PROVIDER_UNAVAILABLE');
  });

  it('preserves legacy server managed generation without snapshots', async () => {
    state.managed.openai = { models: ['gpt-4.1'], apiKey: 'server-key' };
    const value = await input();
    delete value.modelConfigRef;
    await expect(validate(value)).resolves.toBeUndefined();
  });
});
