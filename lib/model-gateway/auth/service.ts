/**
 * Process wiring for subscription sign-in (plan 3.10): one login executor per
 * web process, and owner-bound vault access for the credential APIs. Both use
 * the web role's pool with app.owner_id set per transaction.
 */
import { getPersistencePool } from '@/lib/db/pool-registry';
import { createOwnerBoundQueryable } from '@/lib/db/request-queryable';
import { sealedAuthContext } from '../credentials/auth-context';
import { CredentialVault, type VaultDatabase } from '../credentials/vault';
import { loadPiProvider, runProviderLogin } from '../runtime/pi-registry';
import { LoginService } from './login-sessions';

const SERVICE_KEY = Symbol.for('openmaic.model-gateway.login-service');

function webDatabase(ownerId: string): VaultDatabase {
  return createOwnerBoundQueryable(getPersistencePool(), ownerId);
}

/** The process-wide sign-in executor (survives dev hot reloads). */
export function getLoginService(): LoginService {
  const holder = globalThis as typeof globalThis & { [SERVICE_KEY]?: LoginService };
  holder[SERVICE_KEY] ??= new LoginService({
    database: webDatabase,
    login: async (piProviderId, interaction, deviceId) =>
      runProviderLogin(
        await loadPiProvider(piProviderId),
        sealedAuthContext(),
        interaction,
        deviceId,
      ),
  });
  return holder[SERVICE_KEY];
}

/** Owner-bound vault for the web role (credential list / disconnect). */
export function webCredentialVault(ownerId: string): CredentialVault {
  return new CredentialVault(webDatabase(ownerId), ownerId);
}
