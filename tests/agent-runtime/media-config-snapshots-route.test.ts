import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signedOwnerCookie } from '@/tests/helpers/signed-owner-request';

const mocks = vi.hoisted(() => ({ sync: vi.fn(), revoke: vi.fn() }));
vi.mock('@/lib/config/feature-flags', () => ({ isAgentRuntimeConfigured: () => true }));
vi.mock('@/lib/server/media-config-snapshots', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/media-config-snapshots')>()),
  syncMediaConfigSnapshot: mocks.sync,
  revokeMediaConfigSnapshots: mocks.revoke,
}));

import { DELETE, POST } from '@/app/api/agent/media-config-snapshots/route';

const ownerCookieId = 'a652e716-0e2e-47f5-8432-4ee60f6f0977';
const ref = { id: 'b652e716-0e2e-47f5-8432-4ee60f6f0977', revision: 1 };
const url = 'http://localhost:3000/api/agent/media-config-snapshots';
const snapshot = {
  version: 1,
  image: {
    providerId: 'custom-image-private',
    protocol: 'openai-images',
    apiKey: 'secret-key',
    baseUrl: 'https://images.example.test/v1',
    requiresApiKey: true,
    enabled: true,
    modelId: 'image-model',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('GENERATION_SESSION_SECRET', 'test-signed-owner-secret-32-bytes-long');
  vi.stubEnv('GENERATION_ALLOWED_ORIGINS', 'http://localhost:3000');
  mocks.sync.mockResolvedValue(ref);
  mocks.revoke.mockResolvedValue(1);
});
afterEach(() => vi.unstubAllEnvs());

describe('media configuration snapshot credential boundary', () => {
  it('syncs for the authenticated owner and returns only the opaque ref', async () => {
    const response = await POST(
      new Request(url, {
        method: 'POST',
        headers: { origin: 'http://localhost:3000', cookie: signedOwnerCookie(ownerCookieId) },
        body: JSON.stringify({ snapshot }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ ref });
    expect(mocks.sync).toHaveBeenCalledWith(`anon:${ownerCookieId}`, snapshot);
  });

  it('revokes only the requested provider instance for the signed owner', async () => {
    const response = await DELETE(
      new Request(url, {
        method: 'DELETE',
        headers: { origin: 'http://localhost:3000', cookie: signedOwnerCookie(ownerCookieId) },
        body: JSON.stringify({ providerInstanceId: 'custom-image-private' }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ revoked: 1 });
    expect(mocks.revoke).toHaveBeenCalledWith(`anon:${ownerCookieId}`, 'custom-image-private');
  });

  it('rejects forged identity, oversized bodies and malformed delete input', async () => {
    const forged = await POST(
      new Request(url, {
        method: 'POST',
        headers: {
          origin: 'http://localhost:3000',
          cookie: `generation_owner=${ownerCookieId}.bad`,
        },
        body: JSON.stringify({ snapshot }),
      }),
    );
    expect(forged.status).toBe(401);
    expect(mocks.sync).not.toHaveBeenCalled();

    const oversized = await POST(
      new Request(url, {
        method: 'POST',
        headers: {
          origin: 'http://localhost:3000',
          cookie: signedOwnerCookie(ownerCookieId),
          'content-length': '70000',
        },
        body: '{}',
      }),
    );
    expect(oversized.status).toBe(413);

    const malformed = await DELETE(
      new Request(url, {
        method: 'DELETE',
        headers: { origin: 'http://localhost:3000', cookie: signedOwnerCookie(ownerCookieId) },
        body: JSON.stringify({ providerInstanceId: 'x', ownerId: 'victim' }),
      }),
    );
    expect(malformed.status).toBe(400);
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it('never exposes storage error messages containing credentials', async () => {
    mocks.sync.mockRejectedValue(new Error('database rejected secret-key'));
    const response = await POST(
      new Request(url, {
        method: 'POST',
        headers: { origin: 'http://localhost:3000', cookie: signedOwnerCookie(ownerCookieId) },
        body: JSON.stringify({ snapshot }),
      }),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).not.toContain('secret-key');
  });
});
