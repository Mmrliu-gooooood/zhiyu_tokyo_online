import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

import { isHostedAuthEnabled } from '@/lib/auth/mode';
import { LANDING_PATH, isAuthSessionEntryPath, isPublicAuthPath } from '@/lib/auth/public-paths';
import { safeNextPath } from '@/lib/auth/safe-next';
import { hasSupabaseBrowserConfig, requireSupabaseBrowserConfig } from './env';

function applyCacheHeaders(target: Headers, source?: Record<string, string>): void {
  if (!source) return;
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && value) target.set(key, value);
  }
}

/**
 * Refresh the Supabase Auth session cookies. Adapted from the official
 * Next.js with-supabase example (commit fc4f062ba96f37f971bcbab8858d96e413d86bf9),
 * MIT licensed. Private media routes are not excluded by file extension.
 */
export async function updateSupabaseSession(
  request: NextRequest,
  options: { requireLogin?: boolean } = {},
): Promise<NextResponse> {
  let supabaseResponse = NextResponse.next({ request });
  if (!hasSupabaseBrowserConfig()) {
    return supabaseResponse;
  }

  const { url, publishableKey } = requireSupabaseBrowserConfig();
  const supabase = createServerClient(url, publishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, cacheHeaders) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        supabaseResponse = NextResponse.next({ request });
        for (const { name, value, options: cookieOptions } of cookiesToSet) {
          supabaseResponse.cookies.set(name, value, cookieOptions);
        }
        applyCacheHeaders(supabaseResponse.headers, cacheHeaders);
      },
    },
  });

  const { data } = await supabase.auth.getClaims();
  const user = data?.claims;
  const pathname = request.nextUrl.pathname;
  const requireLogin = options.requireLogin ?? isHostedAuthEnabled();

  if (requireLogin && !user && !isPublicAuthPath(pathname) && !pathname.startsWith('/api/')) {
    const redirectUrl = request.nextUrl.clone();
    const next = safeNextPath(`${pathname}${request.nextUrl.search}`);
    // The bare site address introduces the product; deep links go straight
    // to login and come back afterwards.
    if (next === '/') {
      redirectUrl.pathname = LANDING_PATH;
      redirectUrl.search = '';
    } else {
      redirectUrl.pathname = '/auth/login';
      redirectUrl.searchParams.set('next', next);
    }
    const redirect = NextResponse.redirect(redirectUrl);
    for (const cookie of supabaseResponse.cookies.getAll()) {
      redirect.cookies.set(cookie);
    }
    return redirect;
  }

  if (user && isAuthSessionEntryPath(pathname)) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = safeNextPath(request.nextUrl.searchParams.get('next'));
    redirectUrl.search = '';
    const redirect = NextResponse.redirect(redirectUrl);
    for (const cookie of supabaseResponse.cookies.getAll()) {
      redirect.cookies.set(cookie);
    }
    return redirect;
  }

  return supabaseResponse;
}
