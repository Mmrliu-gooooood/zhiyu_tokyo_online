import { createClient } from '@supabase/supabase-js';

import { getSupabaseSecretKey, requireSupabaseBrowserConfig } from './env';

/**
 * Service-role client for provisioning scripts only. Never import from
 * browser code or ordinary request handlers.
 */
export function createSupabaseAdminClient() {
  const secret = getSupabaseSecretKey();
  if (!secret) {
    throw new Error('SUPABASE_SECRET_KEY is required for admin Auth operations');
  }
  const { url } = requireSupabaseBrowserConfig();
  return createClient(url, secret, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
