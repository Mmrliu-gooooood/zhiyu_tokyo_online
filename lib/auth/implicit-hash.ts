/** True when a URL hash is the default implicit Auth fragment. Never log the hash. */
export function hashContainsImplicitAuth(hash: string): boolean {
  return /(?:^|#|&)access_token=/.test(hash) || /(?:^|#|&)refresh_token=/.test(hash);
}

export interface ImplicitSessionFromHash {
  accessToken: string;
  refreshToken: string;
}

/**
 * Read tokens from an implicit Auth hash so the client can persist a session
 * before the fragment is stripped. Callers must not log the return value.
 */
export function readImplicitSessionFromHash(hash: string): ImplicitSessionFromHash | undefined {
  if (!hashContainsImplicitAuth(hash)) return undefined;
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const accessToken = params.get('access_token')?.trim();
  const refreshToken = params.get('refresh_token')?.trim();
  if (!accessToken || !refreshToken) return undefined;
  return { accessToken, refreshToken };
}
