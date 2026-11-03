import { afterEach, describe, expect, it, vi } from 'vitest';

const verifyOtp = vi.fn();
const exchangeCodeForSession = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseRequestClient: () => ({
    auth: { verifyOtp, exchangeCodeForSession },
  }),
}));

describe('/auth/confirm', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    verifyOtp.mockReset();
    exchangeCodeForSession.mockReset();
  });

  it('GET forwards token_hash to the verify page without spending it', async () => {
    vi.stubEnv('AUTH_MODE', '');
    vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://lzomhnjyymalupgvcato.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
    const { GET } = await import('@/app/auth/confirm/route');
    const response = await GET(
      new Request(
        'http://localhost:3000/auth/confirm?token_hash=testhash&type=recovery&next=/study',
      ),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/auth/verify?token_hash=testhash&type=recovery&next=%2Fstudy',
    );
    expect(verifyOtp).not.toHaveBeenCalled();
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it('GET rejects an unknown type before the verify page', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://lzomhnjyymalupgvcato.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
    const { GET } = await import('@/app/auth/confirm/route');
    const response = await GET(
      new Request('http://localhost:3000/auth/confirm?token_hash=testhash&type=magiclink'),
    );
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/auth/error?error=missing_token',
    );
  });

  it('exchanges a PKCE code when token_hash is absent', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://lzomhnjyymalupgvcato.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
    exchangeCodeForSession.mockResolvedValue({ error: null });
    const { GET } = await import('@/app/auth/confirm/route');
    const response = await GET(new Request('http://localhost:3000/auth/confirm?code=pkce-code'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3000/');
    expect(exchangeCodeForSession).toHaveBeenCalledWith('pkce-code');
  });

  it('POST verifies an email token_hash without requiring AUTH_MODE=supabase', async () => {
    vi.stubEnv('AUTH_MODE', '');
    vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://lzomhnjyymalupgvcato.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
    verifyOtp.mockResolvedValue({ error: null });
    const { POST } = await import('@/app/auth/confirm/route');
    const response = await POST(
      new Request('http://localhost:3000/auth/confirm', {
        method: 'POST',
        body: new URLSearchParams({ token_hash: 'testhash', type: 'email', next: '/study' }),
      }),
    );
    // 303 so the browser follows with GET instead of re-posting the form.
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('http://localhost:3000/study');
    expect(verifyOtp).toHaveBeenCalledWith({ type: 'email', token_hash: 'testhash' });
  });

  it('POST sends recovery to update-password', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://lzomhnjyymalupgvcato.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
    verifyOtp.mockResolvedValue({ error: null });
    const { POST } = await import('@/app/auth/confirm/route');
    const response = await POST(
      new Request('http://localhost:3000/auth/confirm', {
        method: 'POST',
        body: new URLSearchParams({ token_hash: 'recoveryhash', type: 'recovery', next: '/' }),
      }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('http://localhost:3000/auth/update-password');
  });

  it('POST maps a spent recovery token to confirm_failed with a new-reset path', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://lzomhnjyymalupgvcato.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
    verifyOtp.mockResolvedValue({ error: { message: 'otp expired' } });
    const { POST } = await import('@/app/auth/confirm/route');
    const response = await POST(
      new Request('http://localhost:3000/auth/confirm', {
        method: 'POST',
        body: new URLSearchParams({ token_hash: 'usedhash', type: 'recovery' }),
      }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/auth/error?error=confirm_failed&flow=recovery',
    );
  });

  it('POST without a token_hash never calls verifyOtp', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://lzomhnjyymalupgvcato.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
    const { POST } = await import('@/app/auth/confirm/route');
    const response = await POST(
      new Request('http://localhost:3000/auth/confirm', {
        method: 'POST',
        body: new URLSearchParams({ type: 'email' }),
      }),
    );
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/auth/error?error=missing_token',
    );
    expect(verifyOtp).not.toHaveBeenCalled();
  });
});
