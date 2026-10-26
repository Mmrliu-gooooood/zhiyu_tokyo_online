import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const claims = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: { getClaims: async () => ({ data: claims.current ? { claims: claims.current } : null }) },
  }),
}));

async function proxyRedirect(url: string): Promise<URL | null> {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
  const { updateSupabaseSession } = await import('@/lib/supabase/proxy');
  const response = await updateSupabaseSession(new NextRequest(url), { requireLogin: true });
  const location = response.headers.get('location');
  return location ? new URL(location) : null;
}

describe('landing page entry', () => {
  afterEach(() => {
    claims.current = null;
    vi.unstubAllEnvs();
  });

  it('sends signed-out visitors of the bare site address to the landing page', async () => {
    const location = await proxyRedirect('http://localhost:3000/');
    expect(location?.pathname).toBe('/welcome');
    expect(location?.search).toBe('');
  });

  it('keeps deep links going to login with a return path', async () => {
    const location = await proxyRedirect('http://localhost:3000/study?create=1');
    expect(location?.pathname).toBe('/auth/login');
    expect(location?.searchParams.get('next')).toBe('/study?create=1');
  });

  it('serves the landing page without a session', async () => {
    expect(await proxyRedirect('http://localhost:3000/welcome')).toBeNull();
  });

  it('sends signed-in visitors of the landing page into the app', async () => {
    claims.current = { sub: 'user-1' };
    const location = await proxyRedirect('http://localhost:3000/welcome');
    expect(location?.pathname).toBe('/');
  });

  it('renders the landing page without loading an account', async () => {
    const { isPublicAuthPath, isSessionFreePagePath } = await import('@/lib/auth/public-paths');
    expect(isPublicAuthPath('/welcome')).toBe(true);
    expect(isSessionFreePagePath('/welcome')).toBe(true);
    expect(isSessionFreePagePath('/auth/login')).toBe(true);
    expect(isSessionFreePagePath('/')).toBe(false);
    expect(isSessionFreePagePath('/welcome/extra')).toBe(false);
  });
});
