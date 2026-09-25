/**
 * Session-materials host adapter tests — persistence round-trip.
 *
 * Drives the real `fetch_url` tool end-to-end over a PGlite-backed host: the
 * real session store registers the observed URL, the real trust gate admits
 * it, an injected fetch produces a page, and `createWebMaterial` persists the
 * markdown through the material byte store and records the object key on the
 * material row. The round-trip is verified by reading that key back.
 */
import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureAgentSessionSchema, PgAgentSessionStore } from '@openmaic/storage/agent-session/pg';
import { ensureAgentSessionMaterialSchema, PgAgentSessionMaterialStore } from '@openmaic/storage/material/pg';
import type { Queryable } from '@openmaic/storage/asset/pg';
import { setMaterialByteStoreForTests } from '@/lib/server/materials/bytes';

const mocks = vi.hoisted(() => ({
  getAgentSessionStore: vi.fn(),
  getServerPersistenceProvider: vi.fn(),
  getReadyOwnerMaterials: vi.fn(),
}));

vi.mock('@/lib/server/agent-runtime/store', () => ({
  getAgentSessionStore: mocks.getAgentSessionStore,
  nodePostgresTransaction:
    (pool: PGlite) =>
    <T>(body: (transaction: Queryable) => Promise<T>) =>
      pool.transaction((transaction: Queryable) => body(transaction)),
}));

vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: mocks.getServerPersistenceProvider,
}));
vi.mock('@/lib/persistence/owner-materials', () => ({
  getReadyOwnerMaterials: mocks.getReadyOwnerMaterials,
}));

import {
  createWebMaterial,
  bindOwnerMaterialsToSession,
  getSessionMaterial,
  listSessionMaterials,
  sessionMaterialsPromptBlock,
} from '@/lib/server/agent-runtime/session-materials';
import { buildFetchUrlTool } from '@/lib/server/agent-runtime/fetch-url';
import { registerSessionUrls } from '@/lib/server/agent-runtime/session-urls';

let dbCounter = 0;

async function makeHost() {
  const db = new PGlite();
  await db.waitReady;
  await ensureAgentSessionSchema(db);
  const bytes = new Map<string, Buffer>();
  setMaterialByteStoreForTests({
    put: async (key, body) => void bytes.set(key, Buffer.from(body as Uint8Array)),
    get: async (key) => {
      const value = bytes.get(key);
      if (!value) throw new Error(`missing material bytes: ${key}`);
      return value;
    },
    delete: async (key) => void bytes.delete(key),
  });
  const sessionStore = new PgAgentSessionStore(db, {
    withTransaction: (body) => db.transaction((tx: Queryable) => body(tx)),
  });
  dbCounter += 1;
  const connectionString = `postgres://roundtrip-${dbCounter}`;
  mocks.getAgentSessionStore.mockResolvedValue(sessionStore);
  mocks.getServerPersistenceProvider.mockResolvedValue({ pool: db });
  vi.stubEnv('DATABASE_URL', connectionString);
  return { bytes, db, sessionStore };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('session materials persistence', () => {
  it('reuses one owner upload across sessions with distinct stable session material ids', async () => {
    const { bytes, db, sessionStore } = await makeHost();
    await sessionStore.createSession({ id: 'session-1', ownerId: 'owner-a', prompt: 'p' });
    await sessionStore.createSession({ id: 'session-2', ownerId: 'owner-a', prompt: 'p' });
    const sourceId = 'mat_123456789abcdefghjkmnpqrs';
    bytes.set('owner/material.txt', Buffer.from('one source'));
    mocks.getReadyOwnerMaterials.mockResolvedValue([
      { id: sourceId, ossKey: 'owner/material.txt', mime: 'text/plain', originalName: 'material.txt', bytes: 10 },
    ]);

    const first = await bindOwnerMaterialsToSession('session-1', 'owner-a', [sourceId]);
    const second = await bindOwnerMaterialsToSession('session-2', 'owner-a', [sourceId]);
    const retried = await bindOwnerMaterialsToSession('session-1', 'owner-a', [sourceId]);

    expect(first[0]?.materialId).toMatch(/^mat_[0-9abcdefghjkmnpqrstvwxyz]{26}$/);
    expect(second[0]?.materialId).toMatch(/^mat_[0-9abcdefghjkmnpqrstvwxyz]{26}$/);
    expect(first[0]?.materialId).not.toBe(second[0]?.materialId);
    expect(retried).toEqual(first);
    expect((await db.query('SELECT id FROM agent_session_materials')).rows).toHaveLength(2);
    for (const [sessionId, binding] of [['session-1', first], ['session-2', second]] as const) {
      const material = await getSessionMaterial(sessionId, binding[0]!.materialId);
      expect(material?.kind).toBe('source');
      expect(bytes.get(material!.rawAssetId!)?.toString()).toBe('one source');
    }
  });

  it('keeps the existing owner id binding in an older session', async () => {
    const { bytes, db, sessionStore } = await makeHost();
    await sessionStore.createSession({ id: 'session-legacy', ownerId: 'owner-a', prompt: 'p' });
    await ensureAgentSessionMaterialSchema(db);
    const store = new PgAgentSessionMaterialStore(db);
    const sourceId = 'mat_legacy';
    await store.createMaterial('session-legacy', {
      id: sourceId,
      kind: 'source',
      title: 'material.txt',
      rawAssetId: 'materials/session-legacy/mat_legacy/raw.dGV4dC9wbGFpbg',
    });
    mocks.getReadyOwnerMaterials.mockResolvedValue([
      { id: sourceId, ossKey: 'owner/material.txt', mime: 'text/plain', originalName: 'material.txt', bytes: 10 },
    ]);

    expect(await bindOwnerMaterialsToSession('session-legacy', 'owner-a', [sourceId])).toEqual([
      { materialId: sourceId, originalName: 'material.txt', mime: 'text/plain', bytes: 10 },
    ]);
    expect((await db.query('SELECT id FROM agent_session_materials')).rows).toHaveLength(1);
    expect(bytes.size).toBe(0);
  });

  it('persists a fetched page as a web material linking its object key, and reads it back', async () => {
    const { bytes, sessionStore } = await makeHost();
    await sessionStore.createSession({ id: 'session-1', ownerId: 'owner-a', prompt: 'p' });
    // The trust gate admits only session-observed origins.
    await registerSessionUrls('session-1', ['https://example.com/article'], 'user');

    const markdown = '# 甲'.repeat(400);
    const fetchUrl = vi.fn().mockResolvedValue({
      sourceUrl: 'https://example.com/article',
      finalUrl: 'https://example.com/article',
      title: '示例文章',
      markdown,
      fetchedAt: '2026-08-16T08:00:00.000Z',
      contentType: 'text/html',
      truncated: false,
      downloadedBytes: Buffer.byteLength(markdown),
    });
    const fetch = buildFetchUrlTool({ sessionId: 'session-1', fetchUrl });

    const result = await fetch.execute(
      'call_1',
      { url: 'https://example.com/article' } as never,
      undefined,
    );

    // The tool returned the material id; the row and the bytes are durable.
    const trusted = (result.details as { trusted: { materialId: string } }).trusted;
    expect(trusted.materialId).toMatch(/^mat_/);
    const material = await getSessionMaterial('session-1', trusted.materialId);
    expect(material).toMatchObject({
      id: trusted.materialId,
      sessionId: 'session-1',
      kind: 'web',
      title: '示例文章',
      sourceUrl: 'https://example.com/article',
      textChars: markdown.length,
    });
    expect(material?.textAssetId).toMatch(/^materials\/session-1\/mat_[^/]+\/text\.md$/);

    expect(bytes.get(material!.textAssetId!)?.toString('utf8')).toBe(markdown);

    // The session listing shows the new material newest-first.
    const listed = await listSessionMaterials('session-1');
    expect(listed.map((row) => row.id)).toEqual([trusted.materialId]);
  });

  it('refuses to persist when the trust gate refuses the URL', async () => {
    const { sessionStore } = await makeHost();
    await sessionStore.createSession({ id: 'session-1', ownerId: 'owner-a', prompt: 'p' });

    const fetchUrl = vi.fn();
    const fetch = buildFetchUrlTool({ sessionId: 'session-1', fetchUrl });

    const result = await fetch.execute(
      'call_1',
      { url: 'https://invented.example/' } as never,
      undefined,
    );

    expect(result).toMatchObject({ details: { trusted: { status: 'url_not_in_session' } } });
    expect(fetchUrl).not.toHaveBeenCalled();
    expect(await listSessionMaterials('session-1')).toEqual([]);
  });

  it('removes stored bytes when the material row cannot be created', async () => {
    const { bytes } = await makeHost();
    // No session exists, so the material INSERT fails its FK — the adapter
    // must not leak the asset it just stored.
    const page = {
      sourceUrl: 'https://example.com/article',
      finalUrl: 'https://example.com/article',
      title: 'x',
      markdown: 'content',
      fetchedAt: '2026-08-16T08:00:00.000Z',
      contentType: 'text/html',
      truncated: false,
      downloadedBytes: 7,
    };

    await expect(createWebMaterial('session-missing', page)).rejects.toMatchObject({
      name: 'AgentSessionMaterialError',
      code: 'session_missing',
    });
    expect([...bytes.keys()]).toEqual([]);
  });

  it('delegates reads through the session-scoped store', async () => {
    const { sessionStore } = await makeHost();
    await sessionStore.createSession({ id: 'session-1', ownerId: 'owner-a', prompt: 'p' });
    await createWebMaterial('session-1', {
      sourceUrl: 'https://example.com/a',
      finalUrl: 'https://example.com/a',
      title: 'a',
      markdown: 'body',
      fetchedAt: '2026-08-16T08:00:00.000Z',
      contentType: 'text/html',
      truncated: false,
      downloadedBytes: 4,
    });

    const rows = await listSessionMaterials('session-1');
    expect(rows).toHaveLength(1);
    expect(await getSessionMaterial('session-1', rows[0]!.id)).not.toBeNull();
    // A material from another session reads as absent.
    expect(await getSessionMaterial('session-other', rows[0]!.id)).toBeNull();
  });
});

describe('sessionMaterialsPromptBlock', () => {
  it('lists safe metadata and directs the agent to the registered material tools', () => {
    const prompt = sessionMaterialsPromptBlock([
      {
        id: 'mat_1',
        sessionId: 'ses_1',
        kind: 'web',
        title: 'Sample article',
        sourceUrl: 'https://example.com/a',
        textAssetId: 'ast_1',
        rawAssetId: null,
        textChars: 42,
        derivedFrom: null,
        extraction: { status: 'done', attempts: 0 },
        createdAt: new Date(0).toISOString(),
      },
    ]);

    expect(prompt).toContain('Sample article');
    expect(prompt).toContain('list_materials');
    expect(prompt).toContain('read_material');
    expect(prompt).toContain('nextOffset');
    expect(prompt).toContain('search_material');
    expect(prompt).toContain('literal text');
    expect(prompt).toContain('fetched and extracted');
    expect(prompt).toContain('extract_material');
    expect(prompt).toContain('wait_for_materials');
    expect(prompt).toContain('use_material_media');
    expect(prompt).not.toContain('textAssetId');
    expect(prompt).not.toContain('sourceUrl');
  });

  it('emits no block when the session has no materials', () => {
    expect(sessionMaterialsPromptBlock([])).toBe('');
  });
});
