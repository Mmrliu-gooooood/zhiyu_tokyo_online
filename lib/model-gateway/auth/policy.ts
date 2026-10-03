/**
 * Subscription sign-in policy (plan 3.10 / D14): which providers offer the
 * OAuth sign-in method on this deployment. Only the sign-in method is gated;
 * every provider's API-key method is always available.
 *
 * A provider offers sign-in when the operator lists it in
 * MODEL_OAUTH_PROVIDERS (comma-separated application ids, default empty), its
 * catalog entry supports OAuth through a pi provider, and the deployment can
 * hold credentials: hosted sign-in, a database and a credential encryption key.
 */
import { isHostedAuthEnabled } from '@/lib/auth/mode';
import { getDescriptor } from '../catalog/descriptors';
import { credentialEncryptionConfigured } from '../credentials/vault';

type Env = Readonly<Record<string, string | undefined>>;

export interface OAuthDeploymentCheck {
  hostedAuth?: () => boolean;
  env?: Env;
}

/** Whether this deployment can run sign-in and keep credentials at all. */
export function oauthDeploymentCapable(check: OAuthDeploymentCheck = {}): boolean {
  const env = check.env ?? process.env;
  const hostedAuth = check.hostedAuth ?? isHostedAuthEnabled;
  return Boolean(env.DATABASE_URL?.trim()) && credentialEncryptionConfigured(env) && hostedAuth();
}

/** The pi provider that runs a provider's sign-in, when it has one. */
export function oauthPiProviderId(providerId: string): string | undefined {
  const descriptor = getDescriptor(providerId);
  if (!descriptor?.auth.includes('oauth') || descriptor.upstream.kind !== 'pi') return undefined;
  return descriptor.upstream.piProviderId;
}

/** Operator allow-list, reduced to providers that can sign in. */
export function configuredOAuthProviders(env: Env = process.env): string[] {
  const listed = (env.MODEL_OAUTH_PROVIDERS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  return [...new Set(listed)].filter((id) => oauthPiProviderId(id) !== undefined);
}

export function enabledOAuthProviders(check: OAuthDeploymentCheck = {}): string[] {
  if (!oauthDeploymentCapable(check)) return [];
  return configuredOAuthProviders(check.env ?? process.env);
}

export function isOAuthProviderEnabled(
  providerId: string,
  check: OAuthDeploymentCheck = {},
): boolean {
  return enabledOAuthProviders(check).includes(providerId);
}
