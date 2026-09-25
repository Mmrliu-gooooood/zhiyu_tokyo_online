import { hasSupabaseBrowserConfig } from '@/lib/supabase/env';

/**
 * Hosted account mode vs the existing local/dev identity scheme.
 *
 * `AUTH_MODE=supabase` (and the matching public flag) forces every request
 * to have a verified session. Unset keeps anonymous owner, access-code, and
 * development persistence token behavior for unsigned traffic so teach-back,
 * classroom, and generation stay intact. When publishable config is present,
 * a real Supabase session still isolates that request (`user:{uuid}`) even
 * if AUTH_MODE is unset — dual-mode must not leave signed-in users on the
 * shared pile. Auth pages can talk to Supabase without flipping AUTH_MODE.
 */

function readFlag(value: string | undefined): boolean {
  return value === 'supabase';
}

function readPublicMode(): string | undefined {
  return process.env.NEXT_PUBLIC_AUTH_MODE?.trim() || undefined;
}

function readServerMode(): string | undefined {
  return process.env.AUTH_MODE?.trim() || undefined;
}

export type AuthMode = 'legacy' | 'supabase';

export function getAuthMode(): AuthMode {
  const publicMode = readPublicMode();
  const serverMode = readServerMode();
  if (publicMode && serverMode && publicMode !== serverMode) {
    throw new Error(
      'AUTH_MODE and NEXT_PUBLIC_AUTH_MODE must match when both are set',
    );
  }
  if (readFlag(publicMode) || readFlag(serverMode)) return 'supabase';
  return 'legacy';
}

export function isHostedAuthEnabled(): boolean {
  try {
    return getAuthMode() === 'supabase';
  } catch {
    // A mismatched pair is a configuration error. Fail closed for identity
    // decisions rather than silently falling back to anonymous owners.
    return true;
  }
}

/** Login / signup / confirm UI when keys are baked; does not flip AUTH_MODE. */
export function canUseHostedAuthUi(): boolean {
  return hasSupabaseBrowserConfig();
}

export function assertHostedAuthConfig(): void {
  if (!isHostedAuthEnabled()) return;
  const publicMode = readPublicMode();
  const serverMode = readServerMode();
  if (!publicMode || !serverMode) {
    throw new Error(
      'Hosted auth requires both AUTH_MODE=supabase and NEXT_PUBLIC_AUTH_MODE=supabase',
    );
  }
  if (publicMode !== serverMode) {
    throw new Error('AUTH_MODE and NEXT_PUBLIC_AUTH_MODE must be identical');
  }
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL is required in hosted auth mode');
  }
  if (!process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim()) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is required in hosted auth mode',
    );
  }
  if (!process.env.APP_ORIGIN?.trim()) {
    throw new Error('APP_ORIGIN is required in hosted auth mode');
  }
  if (process.env.GENERATION_TRUST_LEGACY_OWNER === '1') {
    throw new Error('GENERATION_TRUST_LEGACY_OWNER cannot be enabled with hosted auth');
  }
}

export const USER_ID_HEADER = 'x-openmaic-user';
export const SESSION_ID_HEADER = 'x-openmaic-session';
export const AUTH_EPOCH_HEADER = 'x-openmaic-epoch';
