import { NextRequest, NextResponse } from 'next/server';

/**
 * Locale-safe alias: `/auth/signup` (no hyphen) → official `/auth/sign-up`.
 * Clones the incoming URL so host, query, and client locale storage stay put.
 */
export function GET(request: NextRequest) {
  const url = request.nextUrl.clone();
  url.pathname = '/auth/sign-up';
  return NextResponse.redirect(url);
}
