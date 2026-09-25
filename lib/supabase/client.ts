import { createBrowserClient } from '@supabase/ssr';

import { requireSupabaseBrowserConfig } from './env';

export function createSupabaseBrowserClient() {
  const { url, publishableKey } = requireSupabaseBrowserConfig();
  return createBrowserClient(url, publishableKey);
}
