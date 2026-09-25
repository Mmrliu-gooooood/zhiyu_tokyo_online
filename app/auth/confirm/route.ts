import { NextResponse } from 'next/server';
import { type EmailOtpType } from '@supabase/supabase-js';

import { consumeRateLimit, clientRateKey } from '@/lib/auth/rate-limit';
import { appOrigin, safeNextPath } from '@/lib/auth/safe-next';
import { hasSupabaseBrowserConfig } from '@/lib/supabase/env';
import { createSupabaseRequestClient } from '@/lib/supabase/server';

const ALLOWED_TYPES = new Set(['email', 'recovery', 'email_change', 'signup']);

/**
 * Official Next.js with-supabase confirm: `token_hash` + `type` query params.
 * Also accepts a PKCE `code`. Works whenever publishable Supabase config is
 * present so the classroom stack can stay AUTH_MODE-unset.
 *
 * Return `NextResponse.redirect` with the cookies verifyOtp wrote. `redirect()`
 * from `next/navigation` can drop those Set-Cookie headers, which leaves a
 * confirmed user on `/` without a session and makes the owner listing 503.
 */
function redirectWithSession(path: string, cookieHeaders: Headers): NextResponse {
  const response = NextResponse.redirect(new URL(path, `${appOrigin()}/`));
  response.headers.set('Cache-Control', 'private, no-store');
  const cookies =
    typeof cookieHeaders.getSetCookie === 'function' ? cookieHeaders.getSetCookie() : [];
  for (const cookie of cookies) {
    response.headers.append('Set-Cookie', cookie);
  }
  return response;
}

function errorRedirect(code: string, cookieHeaders: Headers): NextResponse {
  return redirectWithSession(`/auth/error?error=${encodeURIComponent(code)}`, cookieHeaders);
}

export async function GET(request: Request) {
  const cookieHeaders = new Headers();
  if (!hasSupabaseBrowserConfig()) {
    return errorRedirect('unknown', cookieHeaders);
  }
  const limited = consumeRateLimit(clientRateKey(request, 'confirm'), 30, 60_000);
  if (!limited.allowed) {
    return errorRedirect('rate_limited', cookieHeaders);
  }

  const { searchParams } = new URL(request.url);
  const token_hash = searchParams.get('token_hash');
  const code = searchParams.get('code');
  const type = searchParams.get('type');
  const next = safeNextPath(searchParams.get('next'));

  const supabase = createSupabaseRequestClient(request, cookieHeaders);

  if (code && !token_hash) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      return errorRedirect('confirm_failed', cookieHeaders);
    }
    return redirectWithSession(next, cookieHeaders);
  }

  if (!token_hash || !type || !ALLOWED_TYPES.has(type)) {
    return errorRedirect('missing_token', cookieHeaders);
  }

  const { error } = await supabase.auth.verifyOtp({ type: type as EmailOtpType, token_hash });
  if (error) {
    return errorRedirect('confirm_failed', cookieHeaders);
  }

  if (type === 'recovery') {
    return redirectWithSession('/auth/update-password', cookieHeaders);
  }
  return redirectWithSession(next, cookieHeaders);
}
