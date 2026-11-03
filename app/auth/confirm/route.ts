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
 * A `token_hash` is single-use, and mail providers (QQ Mail, Outlook Safe
 * Links, corporate gateways) open every link in a message before the reader
 * does. So GET never spends the token: it forwards to `/auth/verify`, whose
 * button POSTs back here, and only that POST calls verifyOtp.
 *
 * Return `NextResponse.redirect` with the cookies verifyOtp wrote. `redirect()`
 * from `next/navigation` can drop those Set-Cookie headers, which leaves a
 * confirmed user on `/` without a session and makes the owner listing 503.
 */
function redirectWithSession(
  path: string,
  cookieHeaders: Headers,
  status: 303 | 307 = 307,
): NextResponse {
  const response = NextResponse.redirect(new URL(path, `${appOrigin()}/`), status);
  response.headers.set('Cache-Control', 'private, no-store');
  const cookies =
    typeof cookieHeaders.getSetCookie === 'function' ? cookieHeaders.getSetCookie() : [];
  for (const cookie of cookies) {
    response.headers.append('Set-Cookie', cookie);
  }
  return response;
}

function errorPath(code: string, type?: string | null): string {
  const flow = type === 'recovery' ? '&flow=recovery' : '';
  return `/auth/error?error=${encodeURIComponent(code)}${flow}`;
}

function errorRedirect(code: string, cookieHeaders: Headers): NextResponse {
  return redirectWithSession(errorPath(code), cookieHeaders);
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

  if (code && !token_hash) {
    const supabase = createSupabaseRequestClient(request, cookieHeaders);
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      return errorRedirect('confirm_failed', cookieHeaders);
    }
    return redirectWithSession(next, cookieHeaders);
  }

  if (!token_hash || !type || !ALLOWED_TYPES.has(type)) {
    return errorRedirect('missing_token', cookieHeaders);
  }

  const verify = new URLSearchParams({ token_hash, type, next });
  return redirectWithSession(`/auth/verify?${verify.toString()}`, cookieHeaders);
}

/** The `/auth/verify` button: spend the token and start the session. */
export async function POST(request: Request) {
  const cookieHeaders = new Headers();
  if (!hasSupabaseBrowserConfig()) {
    return redirectWithSession(errorPath('unknown'), cookieHeaders, 303);
  }
  const limited = consumeRateLimit(clientRateKey(request, 'confirm'), 30, 60_000);
  if (!limited.allowed) {
    return redirectWithSession(errorPath('rate_limited'), cookieHeaders, 303);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return redirectWithSession(errorPath('missing_token'), cookieHeaders, 303);
  }
  const field = (name: string) => {
    const value = form.get(name);
    return typeof value === 'string' ? value : null;
  };
  const token_hash = field('token_hash');
  const type = field('type');
  const next = safeNextPath(field('next'));

  if (!token_hash || !type || !ALLOWED_TYPES.has(type)) {
    return redirectWithSession(errorPath('missing_token'), cookieHeaders, 303);
  }

  const supabase = createSupabaseRequestClient(request, cookieHeaders);
  const { error } = await supabase.auth.verifyOtp({ type: type as EmailOtpType, token_hash });
  if (error) {
    return redirectWithSession(errorPath('confirm_failed', type), cookieHeaders, 303);
  }

  if (type === 'recovery') {
    return redirectWithSession('/auth/update-password', cookieHeaders, 303);
  }
  return redirectWithSession(next, cookieHeaders, 303);
}
