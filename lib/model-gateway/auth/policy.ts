/**
 * Subscription sign-in policy (plan 3.10 / D14): which providers offer the
 * OAuth sign-in method on this deployment. Only the sign-in method is gated;
 * every provider's API-key method is always available.
 *
 * R1 ships without the credential vault, so no provider offers sign-in yet.
 * P6 derives this from `MODEL_OAUTH_PROVIDERS` and the deployment's
 * capabilities (hosted auth, database, credential encryption key).
 */
export function enabledOAuthProviders(): string[] {
  return [];
}
