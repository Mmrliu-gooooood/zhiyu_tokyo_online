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
});
