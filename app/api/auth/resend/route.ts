import { AuthError, authJsonResponse } from '@/lib/auth/errors';
import { canUseHostedAuthUi } from '@/lib/auth/mode';
import { assertSameAppOrigin } from '@/lib/auth/origin';
import { consumeRateLimit, clientRateKey } from '@/lib/auth/rate-limit';
import { appOrigin } from '@/lib/auth/safe-next';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

function parseEmail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || !email.includes('@')) return undefined;
  return email;
}

export async function POST(request: Request) {
  const headers = new Headers({ 'Cache-Control': 'private, no-store' });
  if (!canUseHostedAuthUi()) {
    return authJsonResponse(new AuthError('UNAUTHENTICATED', 'Hosted auth is not enabled'), headers);
  }
  try {
    assertSameAppOrigin(request);
    const limited = consumeRateLimit(clientRateKey(request, 'resend'), 5, 10 * 60_000);
    if (!limited.allowed) {
      throw new AuthError('RATE_LIMITED', 'Too many email requests');
    }
    let body: unknown = null;
    try {
      body = await request.json();
    } catch {
      throw new AuthError('INVALID_REQUEST', 'Invalid JSON');
    }
    const email = parseEmail(
      body && typeof body === 'object' && 'email' in body
        ? (body as { email?: unknown }).email
        : undefined,
    );
    if (!email) {
      throw new AuthError('INVALID_REQUEST', 'A valid email is required');
    }
    try {
      const supabase = await createSupabaseServerClient();
      await supabase.auth.resend({
        type: 'signup',
        email,
        options: { emailRedirectTo: `${appOrigin()}/auth/confirm` },
      });
    } catch {
      // Same generic success below. Do not reveal whether the address exists.
    }
    return Response.json({ success: true }, { headers });
  } catch (error) {
    if (error instanceof AuthError) return authJsonResponse(error, headers);
    throw error;
  }
}
