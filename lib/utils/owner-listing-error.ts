/** True when the owner listing failed as auth, not as a down persistence store. */
export function isOwnerListingAuthFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Failed to list owner stages: HTTP (401|503)\b/.test(message);
}
