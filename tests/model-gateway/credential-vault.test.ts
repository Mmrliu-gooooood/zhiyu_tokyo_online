/**
 * Credential vault and scoped pi CredentialStore (plan 3.10, P6-2).
 * PGlite always; the concurrency cases need two real connections and run when
 * TEST_MODEL_CREDENTIALS_DATABASE_URL names a disposable *_rls_proof database.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { Credential, OAuthCredential } from '@earendil-works/pi-ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScopedCredentialStore } from '@/lib/model-gateway/credentials/credential-store';
import {
  CredentialVault,
  CredentialVaultError,
  credentialEncryptionConfigured,
  isReauthFailure,
  sealCredential,
  unsealCredential,
} from '@/lib/model-gateway/credentials/vault';
import {
  openPglite,
  openPostgres,
  pgliteVault,
  postgresUrl,
  postgresVault,
  prepareV21,
} from '@/tests/helpers/model-credentials-db';

const OWNER_A = 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_B = 'user:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const hexKey = () => randomBytes(32).toString('hex');
const env = { MODEL_CREDENTIAL_ENCRYPTION_KEY: hexKey() };

function oauth(tag: string, expiresInMs = 60 * 60_000): OAuthCredential {
  return {
    type: 'oauth',
    access: `access-${tag}`,
    refresh: `refresh-${tag}`,
    expires: Date.now() + expiresInMs,
  };
}

async function codeOf(work: Promise<unknown>): Promise<string> {
  const error = await work.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(CredentialVaultError);
  return (error as CredentialVaultError).code;
}

describe('sealing', () => {
  const context = { ownerId: OWNER_A, credentialId: randomUUID(), secretVersion: 1 };

  it('round-trips and binds owner, credential id and secret version', () => {
    const sealed = sealCredential(oauth('one'), context, env);
    expect(sealed.keyVersion).toBe(1);
    expect(sealed.ciphertext).not.toContain('access-one');
    expect(unsealCredential(sealed.ciphertext, 1, context, env)).toMatchObject({
      access: 'access-one',
    });
    for (const other of [
      { ...context, ownerId: OWNER_B },
      { ...context, credentialId: randomUUID() },
      { ...context, secretVersion: 2 },
    ]) {
      expect(() => unsealCredential(sealed.ciphertext, 1, other, env)).toThrow(
        CredentialVaultError,
      );
    }
    const [format, version, iv, tag, body] = sealed.ciphertext.split('.');
    const flipped = Buffer.from(body!, 'base64');
    flipped[0] = flipped[0]! ^ 1;
    expect(() =>
      unsealCredential(
        [format, version, iv, tag, flipped.toString('base64')].join('.'),
        1,
        context,
        env,
      ),
    ).toThrow(CredentialVaultError);
  });

  it('reads retired keys and seals with the current one', () => {
    const old = hexKey();
    const sealedOld = sealCredential(oauth('old'), context, {
      MODEL_CREDENTIAL_ENCRYPTION_KEY: old,
    });
    const rotated = {
      MODEL_CREDENTIAL_ENCRYPTION_KEY: hexKey(),
      MODEL_CREDENTIAL_KEY_VERSION: '2',
      MODEL_CREDENTIAL_RETIRED_KEYS: `1:${old}`,
    };
    expect(unsealCredential(sealedOld.ciphertext, 1, context, rotated)).toMatchObject({
      access: 'access-old',
    });
    expect(sealCredential(oauth('new'), context, rotated).keyVersion).toBe(2);
    // A key version the deployment no longer knows cannot be read.
    expect(() =>
      unsealCredential(sealedOld.ciphertext, 1, context, {
        MODEL_CREDENTIAL_ENCRYPTION_KEY: rotated.MODEL_CREDENTIAL_ENCRYPTION_KEY,
        MODEL_CREDENTIAL_KEY_VERSION: '2',
      }),
    ).toThrow(CredentialVaultError);
  });

  it('requires a well-formed key', () => {
    expect(credentialEncryptionConfigured({})).toBe(false);
    expect(credentialEncryptionConfigured({ MODEL_CREDENTIAL_ENCRYPTION_KEY: 'short' })).toBe(
      false,
    );
    expect(credentialEncryptionConfigured(env)).toBe(true);
    expect(() => sealCredential(oauth('x'), context, {})).toThrow(CredentialVaultError);
  });
});

describe('refresh failure classification', () => {
  it('signs out only when the provider rejects the refresh token', () => {
    const wrapped = (message: string) =>
      new Error('OAuth refresh failed for xai', { cause: new Error(message) });
    expect(isReauthFailure(wrapped('xAI OAuth refresh failed (HTTP 400): invalid_grant'))).toBe(
      true,
    );
    expect(isReauthFailure(wrapped('token refresh failed (HTTP 401)'))).toBe(true);
    expect(isReauthFailure(wrapped('refresh token is expired'))).toBe(true);
    expect(isReauthFailure(wrapped('fetch failed'))).toBe(false);
    expect(isReauthFailure(wrapped('OAuth refresh failed (HTTP 503)'))).toBe(false);
    expect(
      isReauthFailure(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })),
    ).toBe(false);
    expect(isReauthFailure(new DOMException('The operation timed out.', 'TimeoutError'))).toBe(
      false,
    );
  });
});

describe('credential vault (PGlite)', () => {
  let db: ReturnType<typeof openPglite>;
  const vault = (owner = OWNER_A, role: 'app_web' | 'app_worker' = 'app_web', options = {}) =>
    new CredentialVault(pgliteVault(db.raw, owner, role), owner, { env, ...options });
  const row = async (id: string) =>
    (
      await db.query(
        'SELECT status, ciphertext, secret_version, revoked_at FROM model_credentials WHERE id=$1',
        [id],
      )
    ).rows[0] as
      | { status: string; ciphertext: string | null; secret_version: number; revoked_at: unknown }
      | undefined;

  beforeEach(async () => {
    db = openPglite();
    await prepareV21(db);
  });
  afterEach(async () => {
    await db.close();
  });

  it('saves without exposing secrets and keeps the id when signing in again', async () => {
    const first = await vault().save({
      providerId: 'xai',
      piProviderId: 'xai',
      authKind: 'oauth',
      credential: oauth('one'),
      accountLabel: 'a***@example.com\u0007',
    });
    expect(first).toMatchObject({
      providerId: 'xai',
      piProviderId: 'xai',
      authKind: 'oauth',
      status: 'active',
      accountLabel: 'a***@example.com',
    });
    expect(JSON.stringify(first)).not.toMatch(/access-|refresh-/);
    expect((await row(first.id))?.ciphertext).not.toContain('access-one');

    const again = await vault().save({
      providerId: 'xai',
      piProviderId: 'xai',
      authKind: 'oauth',
      credential: oauth('two'),
    });
    expect(again.id).toBe(first.id);
    expect((await row(first.id))?.secret_version).toBe(2);
    expect((await vault().read(first.id)).credential).toMatchObject({ access: 'access-two' });
    expect(await vault().list()).toHaveLength(1);
    expect(JSON.stringify(await vault().list())).not.toMatch(/access-|refresh-/);
  });

  it('isolates owners', async () => {
    const saved = await vault().save({
      providerId: 'xai',
      piProviderId: 'xai',
      authKind: 'oauth',
      credential: oauth('a'),
    });
    const other = vault(OWNER_B);
    expect(await other.get(saved.id)).toBeUndefined();
    expect(await other.list()).toEqual([]);
    expect(await codeOf(other.read(saved.id))).toBe('MODEL_CREDENTIAL_NOT_FOUND');
    expect(await codeOf(other.modify(saved.id, async () => oauth('stolen')))).toBe(
      'MODEL_CREDENTIAL_NOT_FOUND',
    );
    expect(await other.revoke(saved.id)).toBe(false);
    expect((await vault().read(saved.id)).credential).toMatchObject({ access: 'access-a' });
    // The worker role reads the same owner's credential owner-bound.
    expect((await vault(OWNER_A, 'app_worker').read(saved.id)).credential).toMatchObject({
      access: 'access-a',
    });
    expect(await vault(OWNER_B, 'app_worker').get(saved.id)).toBeUndefined();
  });

  it('modifies under the lock and bumps the secret version only on change', async () => {
    const { id } = await vault().save({
      providerId: 'xai',
      piProviderId: 'xai',
      authKind: 'oauth',
      credential: oauth('one'),
    });
    expect(await vault().modify(id, async () => undefined)).toMatchObject({ access: 'access-one' });
    expect((await row(id))?.secret_version).toBe(1);
    expect(await vault().modify(id, async () => oauth('two'))).toMatchObject({
      access: 'access-two',
    });
    expect((await row(id))?.secret_version).toBe(2);
    expect((await vault().read(id)).credential).toMatchObject({ access: 'access-two' });
  });

  it('marks reauth_required when the refresh token is rejected', async () => {
    const { id } = await vault().save({
      providerId: 'xai',
      piProviderId: 'xai',
      authKind: 'oauth',
      credential: oauth('one'),
    });
    const rejected = new Error('OAuth refresh failed for xai', {
      cause: new Error('xAI OAuth refresh failed (HTTP 400): invalid_grant'),
    });
    await expect(
      vault().modify(id, async () => {
        throw rejected;
      }),
    ).rejects.toBe(rejected);
    expect((await row(id))?.status).toBe('reauth_required');
    expect(await codeOf(vault().read(id))).toBe('MODEL_REAUTH_REQUIRED');
    expect(await codeOf(vault().modify(id, async () => oauth('x')))).toBe('MODEL_REAUTH_REQUIRED');
    // Signing in again restores the same credential.
    await vault().save({
      providerId: 'xai',
      piProviderId: 'xai',
      authKind: 'oauth',
      credential: oauth('new'),
    });
    expect((await vault().read(id)).credential).toMatchObject({ access: 'access-new' });
  });

  it('leaves the credential alone on a temporary failure or the time limit', async () => {
    const { id } = await vault().save({
      providerId: 'xai',
      piProviderId: 'xai',
      authKind: 'oauth',
      credential: oauth('one'),
    });
    const network = new Error('OAuth refresh failed for xai', {
      cause: Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }),
    });
    await expect(
      vault().modify(id, async () => {
        throw network;
      }),
    ).rejects.toBe(network);
    expect((await row(id))?.status).toBe('active');

    const slow = vault(OWNER_A, 'app_web', { modifyTimeLimitMs: 50 });
    expect(await codeOf(slow.modify(id, () => new Promise<Credential>(() => undefined)))).toBe(
      'MODEL_CREDENTIAL_REFRESH_FAILED',
    );
    expect(await row(id)).toMatchObject({ status: 'active', secret_version: 1 });
  });

  it('revokes by dropping the secret, and a revoked credential stays revoked', async () => {
    const { id } = await vault().save({
      providerId: 'xai',
      piProviderId: 'xai',
      authKind: 'oauth',
      credential: oauth('one'),
    });
    expect(await vault().revoke(id)).toBe(true);
    expect(await vault().revoke(id)).toBe(false);
    const stored = await row(id);
    expect(stored?.status).toBe('revoked');
    expect(stored?.ciphertext).toBeNull();
    expect(stored?.revoked_at).not.toBeNull();
    expect(await codeOf(vault().read(id))).toBe('MODEL_CREDENTIAL_REVOKED');
    expect(await codeOf(vault().modify(id, async () => oauth('back')))).toBe(
      'MODEL_CREDENTIAL_REVOKED',
    );
    expect(await vault().list()).toEqual([]);
    // A new sign-in after disconnecting is a new credential.
    const fresh = await vault().save({
      providerId: 'xai',
      piProviderId: 'xai',
      authKind: 'oauth',
      credential: oauth('fresh'),
    });
    expect(fresh.id).not.toBe(id);
  });

  it('exposes exactly one provider entry through the scoped pi store', async () => {
    const { id } = await vault().save({
      providerId: 'openrouter',
      piProviderId: 'openrouter',
      authKind: 'oauth',
      credential: oauth('one'),
    });
    const store = new ScopedCredentialStore(vault(), id, 'openrouter');
    expect(await store.read('openai')).toBeUndefined();
    expect(await store.read('openrouter')).toMatchObject({ access: 'access-one' });
    expect(await store.list()).toEqual([{ providerId: 'openrouter', type: 'oauth' }]);
    await expect(store.modify('openai', async () => oauth('x'))).rejects.toThrow(
      CredentialVaultError,
    );
    expect(await store.modify('openrouter', async () => oauth('two'))).toMatchObject({
      access: 'access-two',
    });
    await store.delete('openai');
    expect(await store.list()).toHaveLength(1);
    await store.delete('openrouter');
    expect(await store.list()).toEqual([]);
    // A disconnected account rejects instead of reading as empty.
    await expect(store.read('openrouter')).rejects.toThrow(CredentialVaultError);
  });
});

describe.skipIf(!postgresUrl)('credential vault concurrency (PostgreSQL)', () => {
  let a: ReturnType<typeof openPostgres>;
  let b: ReturnType<typeof openPostgres>;
  const vaultOn = (db: ReturnType<typeof openPostgres>, options = {}) =>
    new CredentialVault(postgresVault(db.pool, OWNER_A), OWNER_A, { env, ...options });

  beforeEach(async () => {
    a = openPostgres();
    b = openPostgres();
    await prepareV21(a);
  });
  afterEach(async () => {
    await b.pool.end();
    await a.close();
  });

  it('refreshes once when two processes refresh the same credential', async () => {
    const { id } = await vaultOn(a).save({
      providerId: 'xai',
      piProviderId: 'xai',
      authKind: 'oauth',
      credential: oauth('stale', 60_000),
    });
    let refreshes = 0;
    // pi's locked refresh: re-check expiry under the lock, refresh at most once.
    const refreshUnderLock = (vault: CredentialVault) =>
      vault.modify(id, async (current) => {
        if (current.type === 'oauth' && current.expires > Date.now() + 5 * 60_000) return undefined;
        refreshes += 1;
        await new Promise((resolve) => setTimeout(resolve, 200));
        return oauth('fresh');
      });
    const [first, second] = await Promise.all([
      refreshUnderLock(vaultOn(a)),
      refreshUnderLock(vaultOn(b)),
    ]);
    expect(refreshes).toBe(1);
    expect(first).toMatchObject({ access: 'access-fresh' });
    expect(second).toMatchObject({ access: 'access-fresh' });
    const stored = await a.query('SELECT secret_version FROM model_credentials WHERE id=$1', [id]);
    expect(stored.rows[0]?.secret_version).toBe(2);
  });

  it('a refresh in flight cannot bring back a credential revoked meanwhile', async () => {
    const { id } = await vaultOn(a).save({
      providerId: 'xai',
      piProviderId: 'xai',
      authKind: 'oauth',
      credential: oauth('one', 60_000),
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const refreshing = vaultOn(a).modify(id, async () => {
      entered();
      await gate;
      return oauth('refreshed');
    });
    await inside;
    const revoking = vaultOn(b).revoke(id);
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    await refreshing;
    expect(await revoking).toBe(true);
    const stored = await a.query('SELECT status, ciphertext FROM model_credentials WHERE id=$1', [
      id,
    ]);
    expect(stored.rows[0]).toEqual({ status: 'revoked', ciphertext: null });
    expect(await codeOf(vaultOn(a).modify(id, async () => oauth('again')))).toBe(
      'MODEL_CREDENTIAL_REVOKED',
    );
  });

  it('reports a busy credential when the row lock is held too long', async () => {
    const { id } = await vaultOn(a).save({
      providerId: 'xai',
      piProviderId: 'xai',
      authKind: 'oauth',
      credential: oauth('one'),
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const holding = vaultOn(a).modify(id, async () => {
      entered();
      await gate;
      return undefined;
    });
    await inside;
    expect(
      await codeOf(vaultOn(b, { lockTimeoutMs: 200 }).modify(id, async () => oauth('x'))),
    ).toBe('MODEL_CREDENTIAL_BUSY');
    release();
    await holding;
  });
});
