import { AuthError, authJsonResponse } from '@/lib/auth/errors';
import { canUseHostedAuthUi } from '@/lib/auth/mode';
import { assertSameAppOrigin } from '@/lib/auth/origin';
import { consumeRateLimit, clientRateKey } from '@/lib/auth/rate-limit';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const headers = new Headers({ 'Cache-Control': 'private, no-store' });
  if (!canUseHostedAuthUi()) {
    return authJsonResponse(new AuthError('UNAUTHENTICATED', 'Hosted auth is not enabled'), headers);
  }
  try {
    assertSameAppOrigin(request);
    const limited = consumeRateLimit(clientRateKey(request, 'sign-out'), 20, 60_000);
    if (!limited.allowed) {
      throw new AuthError('RATE_LIMITED', 'Too many sign-out attempts');
    }
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.signOut({ scope: 'local' });
    if (error) throw new AuthError('AUTH_UNAVAILABLE', 'Unable to sign out this session');
    return Response.json({ success: true }, { headers });
  } catch (error) {
    if (error instanceof AuthError) return authJsonResponse(error, headers);
    throw error;
  }
}
