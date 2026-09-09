import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveRequestOwnerId } from '@/lib/server/agent-runtime/owner';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';

beforeEach(() => vi.stubEnv('GENERATION_SESSION_SECRET', 'test-signed-owner-secret-32-bytes-long'));
afterEach(() => vi.unstubAllEnvs());

describe('signed PRO owner identity', () => {
  it('mints a signed, HTTP-only cookie and accepts it on a later request independently of generation flags', () => {
    vi.stubEnv('GENERATION_BACKGROUND_ENABLED', '0');
    const headers = new Headers();
    const owner = resolveRequestOwnerId(new Request('http://localhost:3000/agent'), headers);
    const signed = headers.getSetCookie().find((value) => value.startsWith('generation_owner='))!;
    expect(signed).toContain('HttpOnly; SameSite=Strict');
    expect(signed).toContain('Max-Age=2592000');
    const next = new Headers();
    expect(
      resolveRequestOwnerId(
        new Request('http://localhost:3000/agent', { headers: { cookie: signed.split(';')[0] } }),
        next,
      ),
    ).toBe(owner);
    expect(next.has('set-cookie')).toBe(false);
  });
  it('never imports unsigned legacy UUIDs, even with the legacy job flag enabled', () => {
    vi.stubEnv('GENERATION_TRUST_LEGACY_OWNER', '1');
    const id = 'a652e716-0e2e-47f5-8432-4ee60f6f0977';
    const owner = resolveRequestOwnerId(
      new Request('http://localhost:3000/agent', { headers: { cookie: `anonymous_id=${id}` } }),
      new Headers(),
    );
    expect(owner).not.toBe(`anon:${id}`);
  });
  it('rejects forged signatures and fails closed without the deployment secret', () => {
    expect(() =>
      resolveRequestOwnerId(
        new Request('http://localhost:3000/agent', {
          headers: { cookie: 'generation_owner=a652e716-0e2e-47f5-8432-4ee60f6f0977.forged' },
        }),
        new Headers(),
      ),
    ).toThrow('INVALID_GENERATION_SESSION');
    vi.stubEnv('GENERATION_SESSION_SECRET', '');
    expect(() =>
      resolveRequestOwnerId(new Request('http://localhost:3000/agent'), new Headers()),
    ).toThrow('GENERATION_SESSION_UNAVAILABLE');
  });
  it('uses Secure for HTTPS and preserves authenticated host identities', () => {
    const headers = new Headers();
    resolveRequestOwnerId(new Request('https://example.test/agent'), headers);
    expect(headers.get('set-cookie')).toContain('; Secure');
    const authenticatedHeaders = new Headers();
    expect(
      resolveRequestOwnerId(
        new Request('http://localhost:3000/agent'),
        authenticatedHeaders,
        'user-42',
      ),
    ).toBe('user-42');
    expect(authenticatedHeaders.has('set-cookie')).toBe(false);
  });
  it('rejects cross-origin mutations and returns safe auth errors', async () => {
    const handler = vi.fn();
    const response = await withRequestOwnerId(
      new Request('http://localhost:3000/api/agent/model-connections', {
        method: 'POST',
        headers: { origin: 'https://attacker.test' },
      }),
      handler,
    );
    expect(response.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ error: 'ORIGIN_NOT_ALLOWED' });
  });
});
