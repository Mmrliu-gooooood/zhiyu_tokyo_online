/**
 * pi `CredentialStore` over the vault, scoped to one owner and one credential
 * (plan 3.10). pi sees exactly one provider entry: the credential's own pi
 * provider. Every other provider id reads as empty and cannot be written.
 *
 * A credential that needs signing in again, or was disconnected, rejects with
 * the vault error instead of reading as empty: an empty read would let pi fall
 * through to ambient auth, and the caller must learn why the account cannot be
 * used. pi wraps the rejection in `ModelsError` with the vault error as cause.
 */
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from '@earendil-works/pi-ai';
import { CredentialVaultError, type CredentialVault } from './vault';

export class ScopedCredentialStore implements CredentialStore {
  constructor(
    private readonly vault: CredentialVault,
    readonly credentialId: string,
    readonly piProviderId: string,
  ) {}

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    if (providerId !== this.piProviderId) return undefined;
    return (await this.vault.read(this.credentialId)).credential;
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    const summary = await this.vault.get(this.credentialId);
    if (!summary || summary.status !== 'active') return [];
    return [{ providerId: this.piProviderId, type: summary.authKind }];
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    if (providerId !== this.piProviderId) {
      throw new CredentialVaultError('MODEL_CREDENTIAL_NOT_FOUND');
    }
    return this.vault.modify(this.credentialId, (current) => fn(current));
  }

  /** Logout through pi disconnects this credential (same path as the API). */
  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    options?.signal?.throwIfAborted();
    if (providerId !== this.piProviderId) return;
    await this.vault.revoke(this.credentialId);
  }
}
