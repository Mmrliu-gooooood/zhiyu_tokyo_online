import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signedOwnerCookie } from '@/tests/helpers/signed-owner-request';

const mocks = vi.hoisted(() => ({ sync: vi.fn(), revoke: vi.fn() }));
vi.mock('@/lib/config/feature-flags', () => ({ isAgentRuntimeConfigured: () => true }));
vi.mock('@/lib/server/agent-runtime/model-connections', () => ({
  syncModelConnection: mocks.sync,
  revokeModelConnections: mocks.revoke,
  parseProModelRef: (ref: unknown) => ref,
  ProModelConnectionError: class extends Error {},
}));
import { DELETE, POST } from '@/app/api/agent/model-connections/route';

const id = 'a652e716-0e2e-47f5-8432-4ee60f6f0977';
const ref = { id: 'b652e716-0e2e-47f5-8432-4ee60f6f0977', revision: 1 };
const url = 'http://localhost:3000/api/agent/model-connections';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('GENERATION_SESSION_SECRET', 'test-signed-owner-secret-32-bytes-long');
  vi.stubEnv('GENERATION_ALLOWED_ORIGINS', 'http://localhost:3000');
  mocks.sync.mockResolvedValue(ref);
  mocks.revoke.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe('model connection credential boundary', () => {
  it('uses only the authenticated owner and exposes the opaque reference without secrets', async () => {
    const response = await POST(
      new Request(url, {
        method: 'POST',
        headers: { origin: 'http://localhost:3000', cookie: signedOwnerCookie(id) },
        body: JSON.stringify({
          modelString: 'openai:gpt-4o',
          apiKey: 'secret-key',
          ownerId: 'victim',
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ ref });
    expect(mocks.sync).toHaveBeenCalledWith(
      `anon:${id}`,
      expect.objectContaining({ apiKey: 'secret-key' }),
      undefined,
    );
  });

  it('rejects a forged signed cookie before accessing the credential store', async () => {
    const response = await POST(
      new Request(url, {
        method: 'POST',
        headers: { origin: 'http://localhost:3000', cookie: `generation_owner=${id}.forged` },
        body: '{}',
      }),
    );
    expect(response.status).toBe(401);
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it('rejects cross-origin revocation and scopes a legitimate clear to its signed owner', async () => {
    const blocked = await DELETE(
      new Request(url, {
        method: 'DELETE',
        headers: { origin: 'https://attacker.test', cookie: signedOwnerCookie(id) },
        body: '{}',
      }),
    );
    expect(blocked.status).toBe(403);
    expect(mocks.revoke).not.toHaveBeenCalled();
    const allowed = await DELETE(
      new Request(url, {
        method: 'DELETE',
        headers: { origin: 'http://localhost:3000', cookie: signedOwnerCookie(id) },
        body: '{}',
      }),
    );
    expect(allowed.status).toBe(200);
    expect(mocks.revoke).toHaveBeenCalledWith(`anon:${id}`, undefined);
  });

  it('does not expose storage error text even when it contains a key', async () => {
    mocks.sync.mockRejectedValue(new Error('database rejected secret-key'));
    const response = await POST(
      new Request(url, {
        method: 'POST',
        headers: { origin: 'http://localhost:3000', cookie: signedOwnerCookie(id) },
        body: '{}',
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('secret-key');
  });

  it('allows the complete signed-owner POST behind the standalone bind address', async () => {
    const response = await POST(
      new Request('http://0.0.0.0:3000/api/agent/model-connections', {
        method: 'POST',
        headers: {
          host: 'localhost:3000',
          origin: 'http://localhost:3000',
          cookie: signedOwnerCookie(id),
        },
        body: JSON.stringify({ modelString: 'openai:gpt-4o', apiKey: 'secret-key' }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ref });
    expect(mocks.sync).toHaveBeenCalledWith(
      `anon:${id}`,
      expect.objectContaining({ modelString: 'openai:gpt-4o' }),
      undefined,
    );
  });
});
