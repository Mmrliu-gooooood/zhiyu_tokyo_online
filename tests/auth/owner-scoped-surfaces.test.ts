import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from '@/tests/helpers/signed-owner-request';

const OWNER_A = 'user:09ee0532-7110-4bd4-ae73-e95f4d5126b0';
const OWNER_B = 'user:fdef1b67-298d-40c9-bc60-d778816ea1c6';
const JOB_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const mocks = vi.hoisted(() => ({
  ownerId: undefined as string | undefined,
  kvOwnerId: undefined as string | undefined,
  kvParams: [] as unknown[],
  usageOwnerId: undefined as string | undefined,
  jobListOwnerId: undefined as string | undefined,
  jobGet: undefined as { ownerId: string; id: string } | undefined,
  sessionListOwnerId: undefined as string | undefined,
  classroom: null as {
    id: string;
    ownerId?: string;
    stage: { id: string };
    scenes: unknown[];
    createdAt: string;
  } | null,
}));

function principalFor(ownerId: string) {
  return {
    userId: ownerId.slice('user:'.length),
    ownerId,
    learnerKey: ownerId,
    assetPrincipal: ownerId,
    role: 'user' as const,
    sessionId: '22222222-2222-4222-8222-222222222222',
    email: 'isolation@example.com',
    status: 'active' as const,
  };
}

vi.mock('@/lib/auth/session', () => ({
  tryPrincipal: async () => (mocks.ownerId ? principalFor(mocks.ownerId) : undefined),
  requirePrincipal: async () => {
    if (!mocks.ownerId) throw new Error('UNAUTHENTICATED');
    return principalFor(mocks.ownerId);
  },
}));

vi.mock('@/lib/db/request-queryable', () => ({
  createOwnerBoundTransactionSource: (pool: unknown) => pool,
  createOwnerBoundQueryable: (_pool: unknown, ownerId: string) => {
    mocks.kvOwnerId = ownerId;
    return {
      query: async (_sql: string, params?: unknown[]) => {
        mocks.kvParams = params ?? [];
        return { rows: [] };
      },
      withTransaction: async (body: (queryable: unknown) => Promise<unknown>) =>
        body({ query: async () => ({ rows: [] }) }),
    };
  },
}));

vi.mock('pg', () => ({
  Pool: class {
    on() {
      return this;
    }
    end() {
      return Promise.resolve();
    }
    query() {
      return { rows: [] };
    }
  },
}));

vi.mock('@/lib/server/usage-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/usage-storage')>();
  return {
    ...actual,
    readUsageRecords: vi.fn(async (opts: { ownerId?: string }) => {
      mocks.usageOwnerId = opts.ownerId;
      return [
        {
          id: 'a',
          createdAt: Date.UTC(2026, 8, 19),
          kind: 'llm',
          source: 'chat',
          providerId: 'openai',
          modelId: 'gpt-x',
          modelString: 'openai:gpt-x',
          inputTokens: 10,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          reasoningTokens: 0,
          ownerId: OWNER_A,
        },
      ];
    }),
  };
});

vi.mock('@/lib/server/classroom-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/classroom-storage')>();
  return {
    ...actual,
    readClassroom: async () => mocks.classroom,
  };
});

vi.mock('@/lib/server/generation-jobs/runtime', () => ({
  assertGenerationRequestReady: async () => {},
  generationRequestReadiness: async () => ({ worker: true }),
  getGenerationRequestPool: () => ({ query: async () => ({ rows: [] }) }),
}));

vi.mock('@/lib/server/generation-jobs/repository', () => ({
  GenerationJobRepository: class {
    async listJobs(ownerId: string) {
      mocks.jobListOwnerId = ownerId;
      return { jobs: ownerId === OWNER_A ? [{ jobId: JOB_A }] : [], cursor: null };
    }
    async getJobDetail(ownerId: string, id: string) {
      mocks.jobGet = { ownerId, id };
      if (ownerId === OWNER_A && id === JOB_A) return { jobId: id, status: 'queued' };
      return null;
    }
  },
}));

vi.mock('@/lib/server/agent-runtime/store', () => ({
  getAgentSessionStore: async () => ({
    listSessionsByOwner: async (ownerId: string) => {
      mocks.sessionListOwnerId = ownerId;
      return ownerId === OWNER_A ? [{ id: 'chat-a' }] : [];
    },
  }),
}));

describe('user:{uuid} owner-scoped kv / usage / media / chat identity', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    mocks.ownerId = undefined;
    mocks.kvOwnerId = undefined;
    mocks.kvParams = [];
    mocks.usageOwnerId = undefined;
    mocks.jobListOwnerId = undefined;
    mocks.jobGet = undefined;
    mocks.sessionListOwnerId = undefined;
    mocks.classroom = {
      id: 'class-a',
      ownerId: OWNER_A,
      stage: { id: 'stage-a' },
      scenes: [],
      createdAt: '2026-09-19T00:00:00.000Z',
    };
    vi.stubEnv('AUTH_MODE', '');
    vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://lzomhnjyymalupgvcato.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
    vi.stubEnv('DATABASE_URL', 'postgres://owner-scoped-surfaces');
    vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', 'true');
    vi.stubEnv('GENERATION_SESSION_SECRET', 'unit-test-signed-owner-secret-32-bytes-long');
    vi.stubEnv('GENERATION_ALLOWED_ORIGINS', 'http://localhost:3000');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('binds /api/kv reads and writes to the signed-in owner, not a requested owner', async () => {
    mocks.ownerId = OWNER_B;
    const { GET, PUT } = await import('@/app/api/kv/route');
    const read = await GET(new Request('http://localhost:3000/api/kv?key=settings.ui'));
    expect(read.status).toBe(200);
    expect(mocks.kvOwnerId).toBe(OWNER_B);
    expect(mocks.kvParams[0]).toBe(OWNER_B);

    const write = await PUT(
      new Request('http://localhost:3000/api/kv', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
        body: JSON.stringify({ key: 'settings.ui', value: { theme: 'dark' }, ownerId: OWNER_A }),
      }),
    );
    expect(write.status).toBe(200);
    expect(mocks.kvOwnerId).toBe(OWNER_B);
    expect(mocks.kvParams[0]).toBe(OWNER_B);
  });

  it('reads the authenticated profile through the owner-bound RLS transaction', async () => {
    mocks.ownerId = OWNER_B;
    const { GET } = await import('@/app/api/auth/me/route');

    const response = await GET(new Request('http://localhost:3000/api/auth/me'));

    expect(response.status).toBe(200);
    expect(mocks.kvOwnerId).toBe(OWNER_B);
    expect(mocks.kvParams).toEqual([OWNER_B.slice('user:'.length)]);
  });

  it('scopes /api/usage to the signed-in user owner', async () => {
    mocks.ownerId = OWNER_B;
    const { GET } = await import('@/app/api/usage/route');
    const response = await GET(new NextRequest('http://localhost:3000/api/usage'));
    expect(response.status).toBe(200);
    expect(mocks.usageOwnerId).toBe(OWNER_B);
  });

  it('does not bind unsigned /api/usage to a user owner', async () => {
    const { GET } = await import('@/app/api/usage/route');
    const response = await GET(new NextRequest('http://localhost:3000/api/usage'));
    expect(response.status).toBe(200);
    expect(mocks.usageOwnerId).toBeUndefined();
  });

  it('hides another owner classroom from a signed-in user', async () => {
    mocks.ownerId = OWNER_B;
    const { GET } = await import('@/app/api/classroom/route');
    const response = await GET(new NextRequest('http://localhost:3000/api/classroom?id=class-a'));
    expect(response.status).toBe(404);
  });

  it('hides another owner classroom media from a signed-in user', async () => {
    mocks.ownerId = OWNER_B;
    const { GET } = await import('@/app/api/classroom-media/[classroomId]/[...path]/route');
    const response = await GET(
      new NextRequest('http://localhost:3000/api/classroom-media/class-a/media/slide.png'),
      {
        params: Promise.resolve({ classroomId: 'class-a', path: ['media', 'slide.png'] }),
      },
    );
    expect(response.status).toBe(404);
  });

  it('hides user-owned classroom media from unsigned traffic', async () => {
    const { GET } = await import('@/app/api/classroom-media/[classroomId]/[...path]/route');
    const response = await GET(
      new NextRequest('http://localhost:3000/api/classroom-media/class-a/media/slide.png'),
      {
        params: Promise.resolve({ classroomId: 'class-a', path: ['media', 'slide.png'] }),
      },
    );
    expect(response.status).toBe(404);
  });

  it('lists generate-classroom jobs for the signed-in owner only', async () => {
    mocks.ownerId = OWNER_B;
    const { GET } = await import('@/app/api/generate-classroom/route');
    const listed = await GET(new Request('http://localhost:3000/api/generate-classroom'));
    expect(listed.status).toBe(200);
    expect(mocks.jobListOwnerId).toBe(OWNER_B);
    await expect(listed.json()).resolves.toMatchObject({ success: true, jobs: [] });

    const { GET: getJob } = await import('@/app/api/generate-classroom/[jobId]/route');
    const foreign = await getJob(
      new Request(`http://localhost:3000/api/generate-classroom/${JOB_A}`),
      {
        params: Promise.resolve({ jobId: JOB_A }),
      },
    );
    expect(foreign.status).toBe(404);
    expect(mocks.jobGet).toEqual({ ownerId: OWNER_B, id: JOB_A });
  });

  it('lists agent chat sessions for the signed-in owner only', async () => {
    mocks.ownerId = OWNER_B;
    const { GET } = await import('@/app/api/agent/sessions/route');
    const response = await GET(new NextRequest('http://localhost:3000/api/agent/sessions'));
    expect(response.status).toBe(200);
    expect(mocks.sessionListOwnerId).toBe(OWNER_B);
    await expect(response.json()).resolves.toEqual([]);
  });

  it('resolves chat/agent listing identity to user:{uuid} instead of the anon cookie', async () => {
    mocks.ownerId = OWNER_A;
    const { resolveGenerationOwnerAsync } = await import('@/lib/server/generation-jobs/auth');
    const ownerId = await resolveGenerationOwnerAsync(
      new Request('http://localhost:3000/api/agent/sessions', {
        headers: { cookie: 'generation_owner=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.deadbeef' },
      }),
      new Headers(),
      true,
    );
    expect(ownerId).toBe(OWNER_A);
  });
});
