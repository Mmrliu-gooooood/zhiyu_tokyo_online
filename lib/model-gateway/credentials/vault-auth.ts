/**
 * Signed-in account credentials at call time (plan 3.10, P6-4).
 *
 * A `vault` binding carries only the owner and credential id. Before every
 * upstream attempt the gateway opens the owner-bound vault, checks the
 * credential is active and belongs to the bound provider, and lets pi resolve
 * auth through the scoped store (refreshing under the row lock when the token
 * is about to expire). Nothing reaches the model before this succeeds, so a
 * failure here is always `requestSent: false`, and a disconnected account
 * never falls back to another key.
 */
import type { ModelBinding } from '../types';
import { GatewayError } from '../runtime/errors';
import type { CredentialHandle } from './handles';
import { ScopedCredentialStore } from './credential-store';
import {
  CredentialVault,
  isCredentialVaultError,
  isReauthFailure,
  type VaultDatabase,
} from './vault';

/** Owner-bound database for the process role (web: app_web, worker: app_worker). */
export type CredentialDatabaseFactory = (ownerId: string) => Promise<VaultDatabase>;

/**
 * DATABASE_URL is the process's own role in both web and worker deployments.
 * Loaded lazily: deployments without a database never load the pool graph.
 */
export const defaultCredentialDatabase: CredentialDatabaseFactory = async (ownerId) => {
  const [{ getPersistencePool }, { createOwnerBoundQueryable }] = await Promise.all([
    import('@/lib/db/pool-registry'),
    import('@/lib/db/request-queryable'),
  ]);
  return createOwnerBoundQueryable(getPersistencePool(), ownerId);
};

/** A pre-send credential failure. */
export function credentialError(
  code: 'MODEL_AUTH_FAILED' | 'MODEL_REAUTH_REQUIRED' | 'MODEL_CONFIGURATION' | 'MODEL_NETWORK',
  binding: ModelBinding,
  cause?: unknown,
): GatewayError {
  return new GatewayError(code, {
    providerId: binding.providerId,
    modelId: binding.modelId,
    requestSent: false,
    safeToRetry: code === 'MODEL_NETWORK',
    cause,
  });
}

/** The pi credential store for a vault binding, after status / owner / provider checks. */
export async function openVaultStore(
  binding: ModelBinding,
  handle: Extract<CredentialHandle, { kind: 'vault' }>,
  database: CredentialDatabaseFactory,
): Promise<ScopedCredentialStore> {
  const vault = new CredentialVault(await database(handle.ownerId), handle.ownerId);
  const summary = await vault.get(handle.credentialId);
  if (!summary || summary.status === 'revoked') throw credentialError('MODEL_AUTH_FAILED', binding);
  if (summary.status === 'reauth_required') throw credentialError('MODEL_REAUTH_REQUIRED', binding);
  // A credential only ever serves the provider it was signed in for.
  if (
    summary.providerId !== binding.providerId ||
    summary.piProviderId !== binding.model.provider
  ) {
    throw credentialError('MODEL_AUTH_FAILED', binding);
  }
  return new ScopedCredentialStore(vault, handle.credentialId, summary.piProviderId);
}

/**
 * Map a failure while resolving signed-in auth. Rejected sign-ins and
 * disconnected accounts stop; a busy row or a temporary refresh failure is a
 * pre-send network error the retry policy may repeat.
 */
export function credentialFailure(error: unknown, binding: ModelBinding): GatewayError {
  if (error instanceof GatewayError) return error;
  let current: unknown = error;
  for (let depth = 0; current && depth < 6; depth += 1) {
    if (isCredentialVaultError(current)) {
      switch (current.code) {
        case 'MODEL_REAUTH_REQUIRED':
          return credentialError('MODEL_REAUTH_REQUIRED', binding, error);
        case 'MODEL_CREDENTIAL_BUSY':
        case 'MODEL_CREDENTIAL_REFRESH_FAILED':
          return credentialError('MODEL_NETWORK', binding, error);
        case 'MODEL_CREDENTIAL_VAULT_UNAVAILABLE':
          return credentialError('MODEL_CONFIGURATION', binding, error);
        default:
          return credentialError('MODEL_AUTH_FAILED', binding, error);
      }
    }
    current = (current as { cause?: unknown }).cause;
  }
  if (isReauthFailure(error)) return credentialError('MODEL_REAUTH_REQUIRED', binding, error);
  return credentialError('MODEL_NETWORK', binding, error);
}
