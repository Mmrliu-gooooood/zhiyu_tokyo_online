import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

describe('GET /auth/signup alias', () => {
  it('redirects to /auth/sign-up without baking a locale into the path', async () => {
    const { GET } = await import('@/app/auth/signup/route');
    const response = await GET(
      new NextRequest('http://localhost:3000/auth/signup?next=%2Fclassroom%2Fdemo'),
    );
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.origin).toBe('http://localhost:3000');
    expect(location.pathname).toBe('/auth/sign-up');
    expect(location.searchParams.get('next')).toBe('/classroom/demo');
  });
});

describe('auth session entry paths', () => {
  it('treats the hyphenless signup URL like the official sign-up page', async () => {
    const { isAuthSessionEntryPath } = await import('@/lib/auth/public-paths');
    expect(isAuthSessionEntryPath('/auth/login')).toBe(true);
    expect(isAuthSessionEntryPath('/auth/sign-up')).toBe(true);
    expect(isAuthSessionEntryPath('/auth/signup')).toBe(true);
    expect(isAuthSessionEntryPath('/auth/check-email')).toBe(false);
  });
});
