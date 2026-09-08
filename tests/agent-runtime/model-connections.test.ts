import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Queryable, WithTransaction } from '@openmaic/storage/agent-session/pg';

vi.mock('@/lib/ai/providers', () => ({
  getProvider: (id: string) =>
    id === 'openai' ? { type: 'openai', requiresApiKey: true } : undefined,
  parseModelString: (value: string) => ({
    providerId: value.split(':')[0],
    modelId: value.split(':')[1],
  }),
}));
const mocks = vi.hoisted(() => ({ managed: false, unsafe: undefined as string | undefined }));
vi.mock('@/lib/server/provider-config', () => ({
  isServerConfiguredProvider: () => mocks.managed,
}));
vi.mock('@/lib/server/ssrf-guard', () => ({ validateUrlForSSRF: async () => mocks.unsafe }));
vi.mock('@/lib/persistence/server-provider', () => ({ getServerPersistenceProvider: vi.fn() }));
vi.mock('@/lib/server/agent-runtime/store', () => ({ nodePostgresTransaction: vi.fn() }));

import {
  PRO_MODEL_CONNECTION_SCHEMA,
  ProModelConnectionStore,
} from '@/lib/server/agent-runtime/model-connections';

describe('durable encrypted PRO model connections', () => {
  let db: PGlite;
  let store: ProModelConnectionStore;
  const context = {
    modelString: 'openai:gpt-4o',
    apiKey: 'secret-must-not-leak',
    baseUrl: 'https://api.example.test/v1',
  };
  beforeEach(async () => {
    vi.stubEnv('PRO_MODEL_ENCRYPTION_KEY', 'ab'.repeat(32));
    mocks.managed = false;
    mocks.unsafe = undefined;
    db = new PGlite();
    await db.exec(PRO_MODEL_CONNECTION_SCHEMA);
    const queryable: Queryable = {
      query: (sql, values) => db.query(sql, values ? [...values] : []),
    };
    const transaction: WithTransaction = (body) =>
      db.transaction((tx) =>
        body({
          query: (sql, values) => tx.query(sql, values ? [...values] : []),
        }),
      );
    store = new ProModelConnectionStore(queryable, transaction);
  });
  afterEach(async () => {
    await db.close();
    vi.unstubAllEnvs();
  });

  it('persists only ciphertext, deduplicates unchanged syncs, and reloads immutable revisions', async () => {
    const first = await store.sync('owner-a', context);
    expect(await store.sync('owner-a', context)).toEqual(first);
    const second = await store.sync('owner-a', { ...context, apiKey: 'new-key' }, first);
    expect(second).toEqual({ id: first.id, revision: 2 });
    const saved = await db.query('SELECT * FROM pro_model_connection_revisions');
    expect(JSON.stringify(saved.rows)).not.toContain(context.apiKey);
    expect(JSON.stringify(saved.rows)).not.toContain(context.baseUrl);
    expect((await store.load('owner-a', first)).apiKey).toBe(context.apiKey);
    expect((await store.load('owner-a', second)).apiKey).toBe('new-key');
  });

  it('rejects an update based on a stale previous revision with a 409 conflict', async () => {
    const first = await store.sync('owner-a', context);
    const second = await store.sync('owner-a', { ...context, apiKey: 'winner-key' }, first);

    await expect(
      store.sync('owner-a', { ...context, apiKey: 'stale-writer-key' }, first),
    ).rejects.toMatchObject({
      code: 'PRO_MODEL_CONNECTION_STALE',
      status: 409,
    });
    await expect(store.load('owner-a', second)).resolves.toMatchObject({ apiKey: 'winner-key' });
  });

  it('rejects cross-owner reads and replacement, and invalidates existing contexts after revoke', async () => {
    const ref = await store.sync('owner-a', context);
    await expect(store.load('owner-b', ref)).rejects.toMatchObject({
      code: 'PRO_MODEL_CONNECTION_UNAVAILABLE',
    });
    await expect(store.sync('owner-b', context, ref)).rejects.toMatchObject({
      code: 'PRO_MODEL_CONNECTION_UNAVAILABLE',
    });
    const loaded = await store.load('owner-a', ref);
    await store.revoke('owner-b', ref.id);
    await expect(loaded.assertActive!()).resolves.toBeUndefined();
    await store.revoke('owner-a');
    await expect(loaded.assertActive!()).rejects.toMatchObject({
      code: 'PRO_MODEL_CONNECTION_UNAVAILABLE',
    });
    await expect(store.load('owner-a', ref)).rejects.toMatchObject({
      code: 'PRO_MODEL_CONNECTION_UNAVAILABLE',
    });
    expect((await db.query('SELECT * FROM pro_model_connection_revisions')).rows).toHaveLength(0);
  });

  it('fails closed for missing encryption keys and authenticates owner/revision/ciphertext', async () => {
    vi.stubEnv('PRO_MODEL_ENCRYPTION_KEY', '');
    await expect(store.sync('owner-a', context)).rejects.toMatchObject({
      code: 'PRO_MODEL_ENCRYPTION_UNAVAILABLE',
    });
    vi.stubEnv('PRO_MODEL_ENCRYPTION_KEY', 'ab'.repeat(32));
    const ref = await store.sync('owner-a', context);
    await db.query('UPDATE pro_model_connections SET owner_id=$1 WHERE id=$2', ['owner-b', ref.id]);
    await expect(store.load('owner-b', ref)).rejects.toMatchObject({
      code: 'PRO_MODEL_DECRYPTION_FAILED',
    });
  });

  it('never stores browser overrides for a server-managed provider', async () => {
    mocks.managed = true;
    const ref = await store.sync('owner-a', context);
    const loaded = await store.load('owner-a', ref);
    expect(loaded.apiKey).toBeUndefined();
    expect(loaded.baseUrl).toBeUndefined();
  });

  it('allows an authenticated owner to resync after deliberate encryption-key rotation', async () => {
    const previous = await store.sync('owner-a', context);
    vi.stubEnv('PRO_MODEL_ENCRYPTION_KEY', 'cd'.repeat(32));
    await expect(store.load('owner-a', previous)).rejects.toMatchObject({
      code: 'PRO_MODEL_DECRYPTION_FAILED',
    });
    const next = await store.sync('owner-a', context, previous);
    expect(next.revision).toBe(previous.revision + 1);
    expect((await store.load('owner-a', next)).apiKey).toBe(context.apiKey);
  });

  it('rejects missing keys, unsafe endpoints and ambiguous custom protocols without persisting', async () => {
    await expect(store.sync('owner-a', { ...context, apiKey: '' })).rejects.toMatchObject({
      code: 'PRO_MODEL_KEY_REQUIRED',
    });
    await expect(
      store.sync('owner-a', { ...context, modelString: 'custom-test:model' }),
    ).rejects.toMatchObject({ code: 'PRO_MODEL_PROTOCOL_REQUIRED' });
    mocks.unsafe = 'private address';
    await expect(store.sync('owner-a', context)).rejects.toMatchObject({
      code: 'PRO_MODEL_UNSAFE_ENDPOINT',
    });
    expect((await db.query('SELECT * FROM pro_model_connections')).rows).toHaveLength(0);
  });

  it('preserves the explicit Home OpenAI API mode for custom chat-completions connections', async () => {
    const ref = await store.sync('owner-a', {
      ...context,
      modelString: 'custom-test:model',
      providerType: 'openai',
    });
    expect((await store.load('owner-a', ref)).api).toBe('openai-completions');
  });
});
