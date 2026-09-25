'use client';

import { useEffect } from 'react';

import { hashContainsImplicitAuth, readImplicitSessionFromHash } from '@/lib/auth/implicit-hash';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

/**
 * Default Supabase mail templates land on Site URL with an implicit
 * `#access_token=` fragment. Persist that session, then strip the hash
 * without reading or logging token values. Official confirm uses
 * `/auth/confirm?token_hash=&type=`.
 */
export function AuthHashCleanup() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const hash = window.location.hash;
    if (!hashContainsImplicitAuth(hash)) {
      return;
    }
    const session = readImplicitSessionFromHash(hash);
    void (async () => {
      if (session) {
        try {
          const supabase = createSupabaseBrowserClient();
          await supabase.auth.setSession({
            access_token: session.accessToken,
            refresh_token: session.refreshToken,
          });
          window.dispatchEvent(new Event('auth-change'));
        } catch {
          // Still strip the hash; a failed persist must not leave tokens in the URL.
        }
      }
      const url = new URL(window.location.href);
      url.hash = '';
      window.history.replaceState(null, '', `${url.pathname}${url.search}`);
    })();
  }, []);
  return null;
}
