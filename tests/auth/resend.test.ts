import { afterEach, describe, expect, it, vi } from 'vitest';

const resend = vi.fn(async () => ({ error: null }));

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({
    auth: { resend },
  }),
}));

describe('POST /api/auth/resend', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    resend.mockClear();
  });

  it('stays unavailable without publishable config', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', '');
    const { POST } = await import('@/app/api/auth/resend/route');
    const response = await POST(
      new Request('http://localhost:3000/api/auth/resend', {
        method: 'POST',
        headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'a@example.com' }),
      }),
    );
    expect(response.status).toBe(401);
    expect(resend).not.toHaveBeenCalled();
  });

  it('returns generic success and does not leak existence', async () => {
    vi.resetModules();
    vi.stubEnv('AUTH_MODE', '');
    vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://lzomhnjyymalupgvcato.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
    vi.stubEnv('APP_ORIGIN', 'http://localhost:3000');
    resend.mockRejectedValueOnce(new Error('user missing'));
    const { POST } = await import('@/app/api/auth/resend/route');
    const response = await POST(
      new Request('http://localhost:3000/api/auth/resend', {
        method: 'POST',
        headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'a@example.com' }),
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
  });

  it('rejects cross-origin posts', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://lzomhnjyymalupgvcato.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
    vi.stubEnv('APP_ORIGIN', 'http://localhost:3000');
    const { POST } = await import('@/app/api/auth/resend/route');
    const response = await POST(
      new Request('http://localhost:3000/api/auth/resend', {
        method: 'POST',
        headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'a@example.com' }),
      }),
    );
    expect(response.status).toBe(403);
  });
});
