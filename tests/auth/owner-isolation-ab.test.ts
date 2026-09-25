import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { NextRequest, Request } from '@/tests/helpers/signed-owner-request';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureDocumentSchema } from '@openmaic/storage/document/pg';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';

const OWNER_A = 'user:09ee0532-7110-4bd4-ae73-e95f4d5126b0';
const OWNER_B = 'user:fdef1b67-298d-40c9-bc60-d778816ea1c6';
const OWNER_ADMIN = 'user:64b61f8a-79d3-447a-9531-fb5deafd7527';

const mocks = vi.hoisted(() => ({
  ownerId: undefined as string | undefined,
}));

vi.mock('@/lib/auth/session', () => ({
  tryPrincipal: async () =>
    mocks.ownerId
      ? {
          userId: mocks.ownerId.slice('user:'.length),
          ownerId: mocks.ownerId,
          learnerKey: mocks.ownerId,
          assetPrincipal: mocks.ownerId,
          role: mocks.ownerId === OWNER_ADMIN ? 'admin' : 'user',
          sessionId: '22222222-2222-4222-8222-222222222222',
          email: 'isolation@example.com',
          status: 'active',
        }
      : undefined,
  requirePrincipal: async () => {
    throw new Error('requirePrincipal should not run in dual-mode isolation tests');
  },
}));

class PGlitePool {
  constructor(readonly db: PGlite) {}

  query(text: string, params?: unknown[]) {
    return this.db.query(text, params);
  }

  async connect() {
    return {
      query: (text: string, params?: unknown[]) => this.db.query(text, params),
      release() {},
    };
  }

  async end() {
    await this.db.close();
  }
}

function courseDocument(id: string, name = 'Isolation fixture A') {
  const now = 1_800_000_000_000;
  return {
    stage: { id, name, createdAt: now, updatedAt: now },
    scenes: [],
    outline: {
      outlines: [],
      requirement: name,
      generationComplete: false,
      createdAt: now,
      updatedAt: now,
    },
  };
}

function ownerStore(pool: PGlitePool, ownerId: string) {
  return createOwnerBoundDocumentStore({
    pool,
    ownerId,
    validateScene: validateAppScene,
    validateStage: validateAppStage,
  });
}

describe('A vs B owner isolation while AUTH_MODE is unset', () => {
  let pool: PGlitePool;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    mocks.ownerId = undefined;
    vi.stubEnv('AUTH_MODE', '');
    vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://lzomhnjyymalupgvcato.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
    vi.stubEnv('DATABASE_URL', `postgres://owner-isolation-${randomUUID()}`);
    vi.stubEnv('PERSISTENCE_DEV_TOKEN', 'configured');
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', 'true');
    const db = new PGlite();
    await db.waitReady;
    await ensureDocumentSchema(db);
    await ensureStageMetaSchema(db);
    pool = new PGlitePool(db);
  });

  afterEach(async () => {
    await pool.end();
    vi.unstubAllEnvs();
  });

  it('hides A stage from B and from admin on the store and HTTP listing', async () => {
    const connectionString = process.env.DATABASE_URL!;
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(connectionString, () => pool as never);
    const stageId = `stage-iso-ab-${randomUUID()}`;
    await ownerStore(pool, OWNER_A).saveDocument(courseDocument(stageId));

    await expect(ownerStore(pool, OWNER_A).loadDocument(stageId)).resolves.toMatchObject({
      stage: { id: stageId },
    });
    await expect(ownerStore(pool, OWNER_B).loadDocument(stageId)).resolves.toBeNull();
    await expect(ownerStore(pool, OWNER_ADMIN).loadDocument(stageId)).resolves.toBeNull();
    await expect(ownerStore(pool, OWNER_B).listDocuments()).resolves.toEqual([]);
    await expect(ownerStore(pool, OWNER_ADMIN).listDocuments()).resolves.toEqual([]);

    const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/handler');
    mocks.ownerId = OWNER_B;
    const visitorRead = await handlePersistenceRequest(
      new Request(`http://localhost/api/persistence/documents/${stageId}`),
      { poolFactory: () => pool as never },
    );
    expect(visitorRead.status).toBe(404);

    mocks.ownerId = OWNER_ADMIN;
    const adminRead = await handlePersistenceRequest(
      new Request(`http://localhost/api/persistence/documents/${stageId}`),
      { poolFactory: () => pool as never },
    );
    expect(adminRead.status).toBe(404);

    const { GET: listStages } = await import('@/app/api/stages/route');
    const { GET: getStage } = await import('@/app/api/stages/[id]/route');

    mocks.ownerId = OWNER_B;
    const bList = await listStages(new NextRequest('http://localhost/api/stages'));
    expect(bList.status).toBe(200);
    await expect(bList.json()).resolves.toEqual({ stages: [] });
    const bGet = await getStage(new NextRequest(`http://localhost/api/stages/${stageId}`), {
      params: Promise.resolve({ id: stageId }),
    });
    expect(bGet.status).toBe(404);

    mocks.ownerId = OWNER_ADMIN;
    const adminList = await listStages(new NextRequest('http://localhost/api/stages'));
    expect(adminList.status).toBe(200);
    await expect(adminList.json()).resolves.toEqual({ stages: [] });

    mocks.ownerId = OWNER_A;
    const aList = await listStages(new NextRequest('http://localhost/api/stages'));
    expect(aList.status).toBe(200);
    await expect(aList.json()).resolves.toMatchObject({
      stages: [expect.objectContaining({ id: stageId })],
    });
  });

  it('lists the shared anon: library for unsigned traffic and hides user-owned rows', async () => {
    const connectionString = process.env.DATABASE_URL!;
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(connectionString, () => pool as never);
    const userStageId = `stage-iso-user-${randomUUID()}`;
    const anonStageId = `stage-iso-anon-${randomUUID()}`;
    await ownerStore(pool, OWNER_A).saveDocument(courseDocument(userStageId, 'A private'));
    await ownerStore(pool, 'anon:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').saveDocument(
      courseDocument(anonStageId, 'Shared unsigned'),
    );

    await expect(ownerStore(pool, OWNER_A).listDocuments()).resolves.toEqual([
      expect.objectContaining({ id: userStageId }),
    ]);
    await expect(
      ownerStore(pool, 'anon:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb').listLibraryDocuments(),
    ).resolves.toEqual([expect.objectContaining({ id: anonStageId })]);
    await expect(ownerStore(pool, OWNER_B).listLibraryDocuments()).resolves.toEqual([]);
    await expect(ownerStore(pool, OWNER_ADMIN).listLibraryDocuments()).resolves.toEqual([]);

    const { GET: listStages } = await import('@/app/api/stages/route');

    mocks.ownerId = undefined;
    const unsignedList = await listStages(new NextRequest('http://localhost/api/stages'));
    expect(unsignedList.status).toBe(200);
    const unsignedBody = (await unsignedList.json()) as { stages: { id: string }[] };
    expect(unsignedBody.stages.map((stage) => stage.id)).toEqual([anonStageId]);

    mocks.ownerId = OWNER_A;
    const aList = await listStages(new NextRequest('http://localhost/api/stages'));
    const aBody = (await aList.json()) as { stages: { id: string }[] };
    expect(aBody.stages.map((stage) => stage.id)).toEqual([userStageId]);

    mocks.ownerId = OWNER_B;
    const bList = await listStages(new NextRequest('http://localhost/api/stages'));
    await expect(bList.json()).resolves.toEqual({ stages: [] });

    mocks.ownerId = OWNER_ADMIN;
    const adminList = await listStages(new NextRequest('http://localhost/api/stages'));
    await expect(adminList.json()).resolves.toEqual({ stages: [] });
  });
});
