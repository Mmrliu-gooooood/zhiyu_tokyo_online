import { NextRequest, NextResponse } from 'next/server';

import { isPublicAuthPath } from '@/lib/auth/public-paths';
import { canUseHostedAuthUi, isHostedAuthEnabled } from '@/lib/auth/mode';
import { isAgentRuntimeConfigured, isProWorkbenchEnabled } from '@/lib/config/feature-flags';
import { updateSupabaseSession } from '@/lib/supabase/proxy';

function encode(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

function bufToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function verifyToken(token: string, accessCode: string): Promise<boolean> {
  const dotIndex = token.indexOf('.');
  if (dotIndex === -1) return false;

  const timestamp = token.substring(0, dotIndex);
  const signature = token.substring(dotIndex + 1);

  const keyData = encode(accessCode);
  const key = await crypto.subtle.importKey(
    'raw',
    keyData.buffer as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const data = encode(timestamp);
  const expected = bufToHex(await crypto.subtle.sign('HMAC', key, data.buffer as ArrayBuffer));
  if (signature.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < signature.length; i++) {
    mismatch |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Next.js 16 Proxy entry. Merges the previous access-code / workbench gate
 * with Supabase session refresh. Route handlers still authenticate themselves.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const canInspectServerRuntime = process.env.NEXT_RUNTIME !== 'edge';
  const workbenchEnabled =
    isProWorkbenchEnabled() && (!canInspectServerRuntime || isAgentRuntimeConfigured());
  if (!workbenchEnabled && (pathname === '/workbench' || pathname.startsWith('/workbench/'))) {
    return new NextResponse('Not found', { status: 404 });
  }

  if (canUseHostedAuthUi()) {
    const supabaseResponse = await updateSupabaseSession(request, {
      requireLogin: isHostedAuthEnabled(),
    });
    if (isHostedAuthEnabled()) return supabaseResponse;
    if (!process.env.ACCESS_CODE) return supabaseResponse;

    const accessCode = process.env.ACCESS_CODE;
    if (isPublicAuthPath(pathname) || pathname.startsWith('/api/access-code/')) {
      return supabaseResponse;
    }
    const cookie = request.cookies.get('openmaic_access');
    if (cookie?.value && (await verifyToken(cookie.value, accessCode))) {
      return supabaseResponse;
    }
    if (pathname.startsWith('/api/')) {
      return NextResponse.json(
        { success: false, errorCode: 'INVALID_REQUEST', error: 'Access code required' },
        { status: 401 },
      );
    }
    return supabaseResponse;
  }

  const accessCode = process.env.ACCESS_CODE;
  if (!accessCode) {
    return NextResponse.next();
  }

  if (isPublicAuthPath(pathname) || pathname.startsWith('/api/access-code/')) {
    return NextResponse.next();
  }

  const cookie = request.cookies.get('openmaic_access');
  if (cookie?.value && (await verifyToken(cookie.value, accessCode))) {
    return NextResponse.next();
  }

  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { success: false, errorCode: 'INVALID_REQUEST', error: 'Access code required' },
      { status: 401 },
    );
  }

  return NextResponse.next();
}

export const config = {
  // Public brand and font/media assets must bypass the hosted-auth redirect.
  // Otherwise an <img> request receives the login page with status 200 and
  // renders as a broken image on the very login/sign-up surfaces.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff|woff2|ttf|otf)$).*)',
  ],
};
