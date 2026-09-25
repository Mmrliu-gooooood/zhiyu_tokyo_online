import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  claims: vi.fn(),
  account: vi.fn(),
  query: vi.fn(),
  cookie: 'sb-ref-auth-token=refreshed; Path=/; HttpOnly',
}));

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseRequestClient: (_request: Request, headers?: Headers) => {
    headers?.append('set-cookie', mocks.cookie);
    return {
      auth: { getClaims: mocks.claims },
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: mocks.account }) }) }),
    };
  },
}));
vi.mock('@/lib/db/pool-registry', () => ({
  getPersistencePool: () => ({ query: mocks.query }),
}));
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({ pool: {} }),
  createHostedOwnerBoundStores: () => ({ runtimeStore: {}, assetStore: {} }),
}));
vi.mock('@/lib/persistence/owner-bound-document-store', () => ({
  createOwnerBoundDocumentStore: () => ({}),
}));
vi.mock('@openmaic/storage/server', () => ({
  DEFAULT_SIGNED_URL_TTL_SECONDS: 60,
  createStorageHttpHandler:
    (
      _runtime: unknown,
      _document: unknown,
      options: {
        authenticate: (request: unknown) => Promise<unknown>;
      },
    ) =>
    async (
      request: unknown,
      response: {
        writeHead: (status: number) => void;
        end: (body: string) => void;
      },
    ) => {
      const principal = await options.authenticate(request);
      response.writeHead(principal ? 200 : 401);
      response.end(JSON.stringify(principal ?? null));
    },
}));

import { handlePersistenceRequest } from '@/app/api/persistence/[...path]/handler';

const userId = '11111111-1111-4111-8111-111111111111';
const ownerId = `user:${userId}`;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('AUTH_MODE', 'supabase');
  vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', 'supabase');
  vi.stubEnv('DATABASE_URL', 'postgres://test');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'test');
  vi.stubEnv('ASSET_BYTE_EGRESS', 'direct');
  mocks.claims.mockResolvedValue({
    data: {
      claims: {
        sub: userId,
        session_id: '22222222-2222-4222-8222-222222222222',
        email: 'test@example.test',
      },
    },
  });
  mocks.account.mockResolvedValue({ data: { role: 'user', status: 'active' } });
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes('ensure_account')) throw Object.assign(new Error('absent'), { code: '42883' });
    if (sql.includes('session_is_active')) return { rows: [{ ok: true }] };
    return { rows: [{ role: 'user', status: 'active' }] };
  });
});
afterEach(() => vi.unstubAllEnvs());

function request(headers: Record<string, string> = {}, method = 'GET') {
  return new Request('http://localhost:3000/api/persistence/runtime/sessions', { method, headers });
}

describe('embedded persistence request-scoped authentication', () => {
  it('verifies once, keeps the hosted learner/asset partition and refreshed cookie', async () => {
    const response = await handlePersistenceRequest(request({ 'x-learner-key': ownerId }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ key: ownerId, learnerKey: ownerId });
    expect(mocks.claims).toHaveBeenCalledTimes(1);
    expect(mocks.account).toHaveBeenCalledTimes(1);
    expect(response.headers.getSetCookie()).toEqual([mocks.cookie]);
  });

  it('does not share verification across requests and rejects a subsequently revoked session', async () => {
    expect((await handlePersistenceRequest(request())).status).toBe(200);
    mocks.query.mockResolvedValue({ rows: [{ role: 'user', status: 'active', ok: false }] });
    expect((await handlePersistenceRequest(request())).status).toBe(401);
    expect(mocks.claims).toHaveBeenCalledTimes(2);
  });

  it('still rejects a foreign learner marker', async () => {
    expect(
      (await handlePersistenceRequest(request({ 'x-learner-key': 'user:foreign' }))).status,
    ).toBe(401);
    expect(mocks.claims).toHaveBeenCalledTimes(1);
  });

  it('still rejects cross-origin writes after principal verification', async () => {
    expect(
      (await handlePersistenceRequest(request({ origin: 'https://foreign.test' }, 'POST'))).status,
    ).toBe(403);
  });
});
