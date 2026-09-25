import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  signOut: vi.fn(async () => ({ error: null })),
}));

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({ auth: { signOut: mocks.signOut } }),
}));

describe('sign-out route', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
    vi.stubEnv('APP_ORIGIN', 'http://localhost:3000');
    mocks.signOut.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('revokes only the current browser session', async () => {
    const { POST } = await import('@/app/api/auth/sign-out/route');
    const response = await POST(
      new Request('http://localhost:3000/api/auth/sign-out', {
        method: 'POST',
        headers: { origin: 'http://localhost:3000' },
      }),
    );
    expect(response.status).toBe(200);
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });
});
