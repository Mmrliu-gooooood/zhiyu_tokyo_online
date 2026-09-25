export function getSupabaseUrl(): string | undefined {
  return process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || undefined;
}

export function getSupabasePublishableKey(): string | undefined {
  return process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() || undefined;
}

export function getSupabaseSecretKey(): string | undefined {
  // Operator Auth Admin API only (provision/remove). Official with-supabase
  // request clients use the publishable key. Dashboard click-path:
  // Project Settings → API Keys → "Publishable and secret API keys" → secret
  // named `default` (`sb_secret_...`). Put it only in gitignored
  // `.env.hosted.local` as SUPABASE_SECRET_KEY. MCP cannot read this value.
  return process.env.SUPABASE_SECRET_KEY?.trim() || undefined;
}

export function requireSupabaseBrowserConfig(): { url: string; publishableKey: string } {
  const url = getSupabaseUrl();
  const publishableKey = getSupabasePublishableKey();
  if (!url || !publishableKey) {
    throw new Error('Supabase browser configuration is missing');
  }
  return { url, publishableKey };
}

export function hasSupabaseBrowserConfig(): boolean {
  return Boolean(getSupabaseUrl() && getSupabasePublishableKey());
}
