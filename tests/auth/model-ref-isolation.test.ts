import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER_A = 'user:09ee0532-7110-4bd4-ae73-e95f4d5126b0';
const OWNER_B = 'user:fdef1b67-298d-40c9-bc60-d778816ea1c6';
const REF_A = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', revision: 1 };

const mocks = vi.hoisted(() => ({
  ownerId: 'user:fdef1b67-298d-40c9-bc60-d778816ea1c6' as string | undefined,
  sync: vi.fn(),
  snapshot: vi.fn(),
  resolve: vi.fn(),
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
    throw new Error('requirePrincipal should not run in dual-mode modelRef tests');
  },
}));

vi.mock('@/lib/config/feature-flags', () => ({
  isAgentRuntimeConfigured: () => true,
  isAgentRuntimeEnabled: () => true,
}));

vi.mock('@/lib/server/agent-runtime/model-connections', () => {
  class ProModelConnectionError extends Error {
    constructor(
      readonly code: string,
      readonly status = 400,
    ) {
      super(code);
      this.name = 'ProModelConnectionError';
    }
  }
  return {
    ProModelConnectionError,
    parseProModelRef: (value: unknown) => {
      if (!value || typeof value !== 'object') return undefined;
      const record = value as { id?: unknown; revision?: unknown };
      if (typeof record.id !== 'string' || typeof record.revision !== 'number') return undefined;
      return { id: record.id, revision: record.revision };
    },
    normalizeModelConnectionContext: async (value: unknown) => value,
    syncModelConnection: mocks.sync,
    revokeModelConnections: vi.fn(),
    resolveProModelContext: mocks.resolve,
  };
});

vi.mock('@/lib/server/generation-jobs/runtime', () => ({
  assertGenerationRequestReady: async () => {},
  getGenerationRequestPool: () => ({ query: async () => ({ rows: [] }) }),
}));

vi.mock('@/lib/db/request-queryable', () => ({
  createOwnerBoundTransactionSource: (pool: unknown) => pool,
  createOwnerBoundQueryable: () => ({ query: async () => ({ rows: [] }) }),
}));

vi.mock('@/lib/server/generation-model-snapshots', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/generation-model-snapshots')>()),
  syncGenerationModelSnapshot: mocks.snapshot,
}));

vi.mock('@/lib/server/agent-runtime/model-preflight', () => ({
  preflightProModel: async () => ({ chatReady: true, generationReady: true }),
}));

import { POST as postModelConnection } from '@/app/api/agent/model-connections/route';
import { POST as postRuntime } from '@/app/api/agent/runtime/route';
import { POST as postModelSnapshot } from '@/app/api/generate-classroom/model-snapshots/route';

describe('user:{uuid} modelRef / snapshot isolation', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    mocks.ownerId = OWNER_B;
    mocks.sync.mockReset();
    mocks.snapshot.mockReset();
    mocks.resolve.mockReset();
    mocks.sync.mockResolvedValue({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', revision: 1 });
    mocks.snapshot.mockResolvedValue({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', revision: 1 });
    mocks.resolve.mockRejectedValue(
      Object.assign(new Error('PRO_MODEL_CONNECTION_UNAVAILABLE'), {
        code: 'PRO_MODEL_CONNECTION_UNAVAILABLE',
        status: 409,
      }),
    );
    vi.stubEnv('AUTH_MODE', '');
    vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://lzomhnjyymalupgvcato.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
    vi.stubEnv('GENERATION_SESSION_SECRET', 'unit-test-signed-owner-secret-32-bytes-long');
    vi.stubEnv('GENERATION_ALLOWED_ORIGINS', 'http://localhost:3000');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('syncs model connections as the signed-in user, not a body owner or cookie', async () => {
    const response = await postModelConnection(
      new Request('http://localhost:3000/api/agent/model-connections', {
        method: 'POST',
        headers: {
          origin: 'http://localhost:3000',
          'content-type': 'application/json',
          cookie: 'generation_owner=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.deadbeef',
        },
        body: JSON.stringify({
          modelString: 'openai:gpt-4o',
          apiKey: 'secret-must-not-bind-to-a',
          ownerId: OWNER_A,
          ref: REF_A,
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(mocks.sync).toHaveBeenCalledWith(
      OWNER_B,
      expect.objectContaining({ modelString: 'openai:gpt-4o', ownerId: OWNER_A, ref: REF_A }),
      REF_A,
    );
    expect(JSON.stringify(await response.json())).not.toContain('secret-must-not-bind-to-a');
  });

  it('does not resolve a foreign modelRef on Pro runtime preflight', async () => {
    const response = await postRuntime(
      new Request('http://localhost:3000/api/agent/runtime', {
        method: 'POST',
        headers: {
          origin: 'http://localhost:3000',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ modelRef: REF_A }),
      }),
    );
    expect(response.status).toBe(409);
    expect(mocks.resolve).toHaveBeenCalledWith(OWNER_B, REF_A);
    expect(await response.json()).toMatchObject({ error: 'PRO_MODEL_CONNECTION_UNAVAILABLE' });
  });

  it('stores generation model snapshots under the signed-in user', async () => {
    const response = await postModelSnapshot(
      new Request('http://localhost:3000/api/generate-classroom/model-snapshots', {
        method: 'POST',
        headers: {
          origin: 'http://localhost:3000',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          selection: {
            source: 'user',
            providerId: 'openai',
            modelId: 'gpt-test',
            connection: { auth: 'api-key', apiKey: 'private-key' },
          },
        }),
      }),
    );
    expect(response.status).toBe(201);
    expect(mocks.snapshot).toHaveBeenCalledWith(
      OWNER_B,
      expect.objectContaining({
        version: 3,
        selection: expect.objectContaining({
          source: 'user',
          providerId: 'openai',
          modelId: 'gpt-test',
        }),
      }),
    );
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain('private-key');
    expect(body).toMatchObject({ success: true, ref: { revision: 1 } });
  });
});
