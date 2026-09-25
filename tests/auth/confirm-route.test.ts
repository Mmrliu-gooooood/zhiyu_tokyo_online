import { afterEach, describe, expect, it, vi } from 'vitest';

const verifyOtp = vi.fn();
const exchangeCodeForSession = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseRequestClient: () => ({
    auth: { verifyOtp, exchangeCodeForSession },
  }),
}));

describe('GET /auth/confirm', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    verifyOtp.mockReset();
    exchangeCodeForSession.mockReset();
  });

  it('exchanges token_hash without requiring AUTH_MODE=supabase', async () => {
    vi.stubEnv('AUTH_MODE', '');
    vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://lzomhnjyymalupgvcato.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
    verifyOtp.mockResolvedValue({ error: null });
    const { GET } = await import('@/app/auth/confirm/route');
    const response = await GET(
      new Request('http://localhost:3000/auth/confirm?token_hash=testhash&type=email'),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3000/');
    expect(verifyOtp).toHaveBeenCalledWith({ type: 'email', token_hash: 'testhash' });
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
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

  it('sends recovery to update-password after token_hash verify', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://lzomhnjyymalupgvcato.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
    verifyOtp.mockResolvedValue({ error: null });
    const { GET } = await import('@/app/auth/confirm/route');
    const response = await GET(
      new Request('http://localhost:3000/auth/confirm?token_hash=recoveryhash&type=recovery'),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3000/auth/update-password');
  });

  it('maps a reused or expired token_hash to confirm_failed', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://lzomhnjyymalupgvcato.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
    verifyOtp.mockResolvedValue({ error: { message: 'otp expired' } });
    const { GET } = await import('@/app/auth/confirm/route');
    const response = await GET(
      new Request('http://localhost:3000/auth/confirm?token_hash=usedhash&type=email'),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/auth/error?error=confirm_failed',
    );
  });
});
