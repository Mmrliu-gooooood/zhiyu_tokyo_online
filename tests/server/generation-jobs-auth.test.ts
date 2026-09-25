import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertGenerationOrigin, resolveGenerationOwner } from '@/lib/server/generation-jobs/auth';

describe('generation owner sessions', () => {
  beforeEach(() => {
    vi.stubEnv('GENERATION_SESSION_SECRET', 'test-signing-key-with-at-least-32-bytes');
    vi.stubEnv('GENERATION_TRUST_LEGACY_OWNER', '0');
  });
  afterEach(() => vi.unstubAllEnvs());
  it('persists a signed owner on local HTTP and ignores a forged legacy owner', () => {
    const headers = new Headers();
    const owner = resolveGenerationOwner(
      new Request('http://localhost:3000/api/generate-classroom', {
        headers: { cookie: 'anonymous_id=00000000-0000-4000-8000-000000000000' },
      }),
      headers,
      true,
    );
    expect(owner).not.toBe('anon:00000000-0000-4000-8000-000000000000');
    const values = headers.getSetCookie();
    expect(values).toHaveLength(2);
    expect(values[0]).toContain('HttpOnly; SameSite=Strict');
    expect(values[0]).not.toContain('; Secure');
    const req = new Request('http://localhost:3000/api/generate-classroom', {
      headers: { cookie: values[0].split(';')[0] },
    });
    expect(resolveGenerationOwner(req, new Headers())).toBe(owner);
  });
  it('rejects signature tampering and a missing session on read', () => {
    expect(() =>
      resolveGenerationOwner(
        new Request('http://localhost:3000', {
          headers: { cookie: 'generation_owner=00000000-0000-4000-8000-000000000000.forged' },
        }),
        new Headers(),
      ),
    ).toThrow('INVALID_GENERATION_SESSION');
    expect(() =>
      resolveGenerationOwner(new Request('http://localhost:3000'), new Headers()),
    ).toThrow('GENERATION_SESSION_REQUIRED');
  });
  it('requires an explicit same-origin mutation and ignores forwarded host', () => {
    for (const origin of [undefined, 'https://evil.example']) {
      expect(() =>
        assertGenerationOrigin(
          new Request('http://localhost:3000/api/generate-classroom', {
            method: 'POST',
            headers: { ...(origin ? { origin } : {}), 'x-forwarded-host': 'localhost:3000' },
          }),
        ),
      ).toThrow();
    }
    expect(() =>
      assertGenerationOrigin(
        new Request('http://localhost:3000/api/generate-classroom', {
          method: 'POST',
          headers: { origin: 'http://localhost:3000' },
        }),
      ),
    ).not.toThrow();
  });
  it('fails closed without a stable signing key', () => {
    vi.stubEnv('GENERATION_SESSION_SECRET', '');
    expect(() =>
      resolveGenerationOwner(new Request('http://localhost:3000'), new Headers(), true),
    ).toThrow('GENERATION_SESSION_UNAVAILABLE');
  });

  it('accepts the actual allowlisted Host when standalone exposes its 0.0.0.0 bind URL', () => {
    expect(() =>
      assertGenerationOrigin(
        new Request('http://0.0.0.0:3000/api/agent/model-connections', {
          method: 'POST',
          headers: { host: 'localhost:3000', origin: 'http://localhost:3000' },
        }),
      ),
    ).not.toThrow();
  });

  it.each([
    'evil.example:3000',
    'localhost:3000@evil.example',
    'localhost:3000/path',
    'localhost:3000,evil.example',
  ])(
    'rejects an untrusted or malformed actual Host %s despite forged forwarded headers',
    (host) => {
      expect(() =>
        assertGenerationOrigin(
          new Request('http://0.0.0.0:3000/api/agent/model-connections', {
            method: 'POST',
            headers: {
              host,
              origin: 'http://localhost:3000',
              'x-forwarded-host': 'localhost:3000',
              'x-forwarded-proto': 'http',
            },
          }),
        ),
      ).toThrow('ORIGIN_NOT_ALLOWED');
    },
  );

  it('uses a Supabase session owner in dual-mode even when AUTH_MODE is unset', async () => {
    vi.resetModules();
    vi.stubEnv('AUTH_MODE', '');
    vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
    vi.doMock('@/lib/auth/session', () => ({
      tryPrincipal: async () => ({
        ownerId: 'user:11111111-1111-4111-8111-111111111111',
      }),
      requirePrincipal: async () => {
        throw new Error('hosted requirePrincipal should not run in dual-mode');
      },
    }));
    const { resolveGenerationOwnerAsync } = await import('@/lib/server/generation-jobs/auth');
    const owner = await resolveGenerationOwnerAsync(
      new Request('http://localhost:3000/api/stages', {
        headers: { origin: 'http://localhost:3000' },
      }),
      new Headers(),
      true,
    );
    expect(owner).toBe('user:11111111-1111-4111-8111-111111111111');
  });
});
