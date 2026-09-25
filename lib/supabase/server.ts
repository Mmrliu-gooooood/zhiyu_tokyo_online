import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

import { requireSupabaseBrowserConfig } from './env';

/**
 * Request-scoped Supabase client for Server Components, Route Handlers,
 * and Server Actions. Cookie writes from Server Components are ignored;
 * Proxy is responsible for persisting refreshed tokens.
 */
export async function createSupabaseServerClient() {
  const { url, publishableKey } = requireSupabaseBrowserConfig();
  const cookieStore = await cookies();

  return createServerClient(url, publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet, headers) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components cannot set cookies. Proxy refreshes the session.
        }
        if (headers) {
          void headers;
        }
      },
    },
  });
}

/**
 * Build a server client from an incoming Request. Used by Node HTTP handlers
 * and tests that do not have Next cookies() available.
 */
export function createSupabaseRequestClient(request: Request, responseHeaders?: Headers) {
  const { url, publishableKey } = requireSupabaseBrowserConfig();
  return createServerClient(url, publishableKey, {
    cookies: {
      getAll() {
        const header = request.headers.get('cookie') ?? '';
        return header
          .split(';')
          .map((part) => part.trim())
          .filter(Boolean)
          .map((part) => {
            const eq = part.indexOf('=');
            if (eq < 0) return { name: part, value: '' };
            return { name: part.slice(0, eq), value: part.slice(eq + 1) };
          });
      },
      setAll(cookiesToSet, cacheHeaders) {
        if (!responseHeaders) return;
        for (const { name, value, options } of cookiesToSet) {
          const parts = [`${name}=${value}`];
          if (options?.path) parts.push(`Path=${options.path}`);
          if (options?.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
          if (options?.domain) parts.push(`Domain=${options.domain}`);
          if (options?.sameSite) parts.push(`SameSite=${options.sameSite}`);
          if (options?.secure) parts.push('Secure');
          if (options?.httpOnly) parts.push('HttpOnly');
          responseHeaders.append('Set-Cookie', parts.join('; '));
        }
        if (cacheHeaders) {
          for (const [key, value] of Object.entries(cacheHeaders)) {
            if (typeof value === 'string') responseHeaders.set(key, value);
          }
        }
      },
    },
  });
}
