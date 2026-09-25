import { afterEach, describe, expect, it, vi } from 'vitest';

describe('hostedAuthGate', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('allows legacy requests without a session', async () => {
    vi.resetModules();
    vi.stubEnv('AUTH_MODE', '');
    vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', '');
    const { hostedAuthGate } = await import('@/lib/auth/api');
    const response = await hostedAuthGate(new Request('http://localhost/api/chat', { method: 'POST' }));
    expect(response).toBeNull();
  });

  it('fails closed when hosted mode is on without Supabase config', async () => {
    vi.resetModules();
    vi.stubEnv('AUTH_MODE', 'supabase');
    vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', 'supabase');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', '');
    const { hostedAuthGate } = await import('@/lib/auth/api');
    const response = await hostedAuthGate(new Request('http://localhost/api/chat', { method: 'POST' }));
    expect(response).not.toBeNull();
    expect(response?.status).toBeGreaterThanOrEqual(401);
  });
});
