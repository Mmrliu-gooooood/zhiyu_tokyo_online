/**
 * Credential vault (plan 3.10, P6-2): the model_credentials repository.
 *
 * - Every operation is scoped to one owner. Queries run in owner-bound
 *   transactions (app.owner_id), and every statement also filters by owner_id,
 *   so a missing policy can never widen access.
 * - Secrets are sealed with AES-256-GCM; the AAD binds owner, credential id and
 *   secret version, so a ciphertext copied to another row or replayed after a
 *   rotation does not decrypt.
 * - `modify` is the only write path for an existing secret: row lock
 *   (lock_timeout 10 s) → status must still be active → caller's function
 *   (bounded to 20 s) → atomic write with secret_version + 1. Revocation takes
 *   the same lock, so a refresh in flight cannot bring a revoked credential back.
 * - A refresh the provider rejects (invalid_grant and the like) marks the
 *   credential reauth_required; a temporary failure leaves it untouched.
 *
 * No API here returns a secret to a caller outside the gateway.
 */
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Credential } from '@earendil-works/pi-ai';

export const LOCK_TIMEOUT_MS = 10_000;
export const MODIFY_TIME_LIMIT_MS = 20_000;
const AAD_TAG = 'model-credential:v1';

export type CredentialStatus = 'active' | 'reauth_required' | 'revoked';
export type CredentialAuthKind = 'oauth' | 'api_key';

export type VaultErrorCode =
  | 'MODEL_CREDENTIAL_VAULT_UNAVAILABLE'
  | 'MODEL_CREDENTIAL_NOT_FOUND'
  | 'MODEL_REAUTH_REQUIRED'
  | 'MODEL_CREDENTIAL_REVOKED'
  | 'MODEL_CREDENTIAL_BUSY'
  | 'MODEL_CREDENTIAL_DECRYPTION_FAILED'
  | 'MODEL_CREDENTIAL_REFRESH_FAILED';

const MESSAGES: Record<VaultErrorCode, string> = {
  MODEL_CREDENTIAL_VAULT_UNAVAILABLE:
    'Signed-in model accounts are not available on this deployment.',
  MODEL_CREDENTIAL_NOT_FOUND: 'The signed-in model account was not found.',
  MODEL_REAUTH_REQUIRED: 'The model account must be signed in again.',
  MODEL_CREDENTIAL_REVOKED: 'The model account was disconnected.',
  MODEL_CREDENTIAL_BUSY: 'The model account is being updated. Try again shortly.',
  MODEL_CREDENTIAL_DECRYPTION_FAILED: 'The signed-in model account could not be read.',
  MODEL_CREDENTIAL_REFRESH_FAILED: 'The model account could not be refreshed. Try again shortly.',
};

/** Fixed, secret-free messages; the cause is kept for server logs only. */
export class CredentialVaultError extends Error {
  constructor(
    readonly code: VaultErrorCode,
    options?: { cause?: unknown },
  ) {
    super(MESSAGES[code], options);
    this.name = 'CredentialVaultError';
  }
}

export function isCredentialVaultError(error: unknown): error is CredentialVaultError {
  return error instanceof CredentialVaultError;
}

// ---------------------------------------------------------------------------
// Keyring

interface Keyring {
  current: { version: number; key: Buffer };
  byVersion: ReadonlyMap<number, Buffer>;
}

const HEX_KEY = /^[a-f0-9]{64}$/i;

/**
 * MODEL_CREDENTIAL_ENCRYPTION_KEY (64 hex) is the current key, version
 * MODEL_CREDENTIAL_KEY_VERSION (default 1). Retired keys stay readable through
 * MODEL_CREDENTIAL_RETIRED_KEYS="version:hex,…"; every write re-seals with the
 * current key, so rotation completes as credentials are refreshed.
 */
function readKeyring(env: Readonly<Record<string, string | undefined>>): Keyring | undefined {
  const configured = env.MODEL_CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!configured || !HEX_KEY.test(configured)) return undefined;
  const version = Number(env.MODEL_CREDENTIAL_KEY_VERSION?.trim() || '1');
  if (!Number.isInteger(version) || version < 1) return undefined;
  const byVersion = new Map<number, Buffer>();
  for (const entry of (env.MODEL_CREDENTIAL_RETIRED_KEYS ?? '').split(',')) {
    const [rawVersion, hex] = entry.trim().split(':');
    const retired = Number(rawVersion);
    if (!rawVersion || !hex) continue;
    if (!Number.isInteger(retired) || retired < 1 || !HEX_KEY.test(hex)) return undefined;
    byVersion.set(retired, Buffer.from(hex, 'hex'));
  }
  const key = Buffer.from(configured, 'hex');
  byVersion.set(version, key);
  return { current: { version, key }, byVersion };
}

/** Whether this deployment can seal credentials (key present and well formed). */
export function credentialEncryptionConfigured(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return readKeyring(env) !== undefined;
}

// ---------------------------------------------------------------------------
// Sealing

const oauthCredentialSchema = z
  .object({
    type: z.literal('oauth'),
    access: z.string().min(1),
    refresh: z.string(),
    expires: z.number().finite(),
  })
  .passthrough();
const apiKeyCredentialSchema = z.object({
  type: z.literal('api_key'),
  key: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});
const credentialSchema = z.union([oauthCredentialSchema, apiKeyCredentialSchema]);

interface SealContext {
  ownerId: string;
  credentialId: string;
  secretVersion: number;
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Seal UTF-8 text with the current key. `aadParts` binds the ciphertext to
 * its row; a different binding does not decrypt.
 */
export function sealText(
  text: string,
  aadParts: readonly unknown[],
  env: Env = process.env,
): { ciphertext: string; keyVersion: number } {
  const keyring = readKeyring(env);
  if (!keyring) throw new CredentialVaultError('MODEL_CREDENTIAL_VAULT_UNAVAILABLE');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyring.current.key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(aadParts)));
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return {
    ciphertext: [
      'v1',
      String(keyring.current.version),
      iv.toString('base64'),
      cipher.getAuthTag().toString('base64'),
      encrypted.toString('base64'),
    ].join('.'),
    keyVersion: keyring.current.version,
  };
}

/** Inverse of sealText; any mismatch reads as MODEL_CREDENTIAL_DECRYPTION_FAILED. */
export function unsealText(
  ciphertext: string,
  aadParts: readonly unknown[],
  env: Env = process.env,
): string {
  const keyring = readKeyring(env);
  if (!keyring) throw new CredentialVaultError('MODEL_CREDENTIAL_VAULT_UNAVAILABLE');
  try {
    const [format, version, iv, tag, encrypted, extra] = ciphertext.split('.');
    if (format !== 'v1' || extra !== undefined || !version || !iv || !tag || !encrypted) {
      throw new Error();
    }
    const key = keyring.byVersion.get(Number(version));
    if (!key) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAAD(Buffer.from(JSON.stringify(aadParts)));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new CredentialVaultError('MODEL_CREDENTIAL_DECRYPTION_FAILED');
  }
}

function credentialAad(context: SealContext): readonly unknown[] {
  return [AAD_TAG, context.ownerId, context.credentialId, context.secretVersion];
}

export function sealCredential(
  credential: Credential,
  context: SealContext,
  env: Env = process.env,
): { ciphertext: string; keyVersion: number } {
  return sealText(JSON.stringify(credentialSchema.parse(credential)), credentialAad(context), env);
}

/**
 * `keyVersion` is the row's key_version column; it must agree with the
 * version recorded in the ciphertext.
 */
export function unsealCredential(
  ciphertext: string,
  keyVersion: number,
  context: SealContext,
  env: Env = process.env,
): Credential {
  if (ciphertext.split('.')[1] !== String(keyVersion)) {
    throw new CredentialVaultError('MODEL_CREDENTIAL_DECRYPTION_FAILED');
  }
  const plain = unsealText(ciphertext, credentialAad(context), env);
  try {
    return credentialSchema.parse(JSON.parse(plain)) as Credential;
  } catch {
    throw new CredentialVaultError('MODEL_CREDENTIAL_DECRYPTION_FAILED');
  }
}

// ---------------------------------------------------------------------------
// Refresh failure classification

const REAUTH_PATTERN =
  /\b(invalid_grant|invalid_token|unauthorized_client|invalid_client|access_denied)\b|token (has been |was )?revoked|refresh token (is )?(invalid|expired|revoked)|\(HTTP (400|401|403)\)/i;

/**
 * True when the provider rejected the refresh token itself (sign-in needed
 * again). Network errors, timeouts, 5xx and anything unrecognised are treated
 * as temporary: a flaky network must never sign a user out.
 */
export function isReauthFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 6; depth += 1) {
    const message = current instanceof Error ? current.message : String(current);
    if (REAUTH_PATTERN.test(message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Repository

export interface Queryable {
  query<TRow extends Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: TRow[] }>;
}

/** An owner-bound transaction runner (lib/db/request-queryable.ts or the worker equivalent). */
export interface VaultDatabase {
  withTransaction<T>(body: (db: Queryable) => Promise<T>): Promise<T>;
}

export interface CredentialSummary {
  id: string;
  providerId: string;
  piProviderId: string;
  authKind: CredentialAuthKind;
  status: CredentialStatus;
  accountLabel: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CredentialRow extends Record<string, unknown> {
  id: string;
  provider_id: string;
  pi_provider_id: string;
  auth_kind: CredentialAuthKind;
  status: CredentialStatus;
  account_label: string | null;
  ciphertext: string | null;
  key_version: number;
  secret_version: number;
  expires_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const SUMMARY_COLUMNS =
  'id, provider_id, pi_provider_id, auth_kind, status, account_label, expires_at, created_at, updated_at';
const SECRET_COLUMNS = `${SUMMARY_COLUMNS}, ciphertext, key_version, secret_version`;
const UUID = z.uuid();

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function summaryOf(row: CredentialRow): CredentialSummary {
  return {
    id: row.id,
    providerId: row.provider_id,
    piProviderId: row.pi_provider_id,
    authKind: row.auth_kind,
    status: row.status,
    accountLabel: row.account_label,
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

/** Non-secret display label: printable, at most 200 characters. */
export function sanitizeAccountLabel(label: string | undefined | null): string | null {
  if (!label) return null;
  const clean = label.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return clean ? clean.slice(0, 200) : null;
}

function expiryOf(credential: Credential): string | null {
  return credential.type === 'oauth' && Number.isFinite(credential.expires)
    ? new Date(credential.expires).toISOString()
    : null;
}

function statusError(status: CredentialStatus): CredentialVaultError {
  return new CredentialVaultError(
    status === 'reauth_required' ? 'MODEL_REAUTH_REQUIRED' : 'MODEL_CREDENTIAL_REVOKED',
  );
}

function isLockTimeout(error: unknown): boolean {
  return (error as { code?: unknown })?.code === '55P03';
}

function withTimeLimit<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new CredentialVaultError('MODEL_CREDENTIAL_REFRESH_FAILED')),
      ms,
    );
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

export interface SaveCredentialInput {
  providerId: string;
  piProviderId: string;
  authKind: CredentialAuthKind;
  credential: Credential;
  accountLabel?: string | null;
}

export interface CredentialVaultOptions {
  env?: Readonly<Record<string, string | undefined>>;
  lockTimeoutMs?: number;
  modifyTimeLimitMs?: number;
}

export class CredentialVault {
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #lockTimeoutMs: number;
  readonly #modifyTimeLimitMs: number;

  constructor(
    private readonly db: VaultDatabase,
    readonly ownerId: string,
    options: CredentialVaultOptions = {},
  ) {
    if (!ownerId) throw new CredentialVaultError('MODEL_CREDENTIAL_VAULT_UNAVAILABLE');
    this.#env = options.env ?? process.env;
    this.#lockTimeoutMs = options.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
    this.#modifyTimeLimitMs = options.modifyTimeLimitMs ?? MODIFY_TIME_LIMIT_MS;
  }

  async list(): Promise<CredentialSummary[]> {
    return this.db.withTransaction(async (db) => {
      const result = await db.query<CredentialRow>(
        `SELECT ${SUMMARY_COLUMNS} FROM model_credentials
          WHERE owner_id=$1 AND status <> 'revoked' ORDER BY created_at`,
        [this.ownerId],
      );
      return result.rows.map(summaryOf);
    });
  }

  async get(credentialId: string): Promise<CredentialSummary | undefined> {
    if (!UUID.safeParse(credentialId).success) return undefined;
    return this.db.withTransaction(async (db) => {
      const result = await db.query<CredentialRow>(
        `SELECT ${SUMMARY_COLUMNS} FROM model_credentials WHERE id=$1 AND owner_id=$2`,
        [credentialId, this.ownerId],
      );
      return result.rows[0] ? summaryOf(result.rows[0]) : undefined;
    });
  }

  /** The current secret of an active credential (gateway-internal use). */
  async read(
    credentialId: string,
  ): Promise<{ summary: CredentialSummary; credential: Credential }> {
    if (!UUID.safeParse(credentialId).success) {
      throw new CredentialVaultError('MODEL_CREDENTIAL_NOT_FOUND');
    }
    return this.db.withTransaction(async (db) => {
      const result = await db.query<CredentialRow>(
        `SELECT ${SECRET_COLUMNS} FROM model_credentials WHERE id=$1 AND owner_id=$2`,
        [credentialId, this.ownerId],
      );
      const row = result.rows[0];
      if (!row) throw new CredentialVaultError('MODEL_CREDENTIAL_NOT_FOUND');
      if (row.status !== 'active' || !row.ciphertext) throw statusError(row.status);
      return { summary: summaryOf(row), credential: this.#unseal(row) };
    });
  }

  /**
   * Serialized read-modify-write of one credential. `fn` returns the new
   * credential, or undefined to keep the stored one. Rejections from `fn`
   * propagate; a rejected refresh token also marks the credential
   * reauth_required.
   */
  async modify(
    credentialId: string,
    fn: (current: Credential) => Promise<Credential | undefined>,
  ): Promise<Credential> {
    if (!UUID.safeParse(credentialId).success) {
      throw new CredentialVaultError('MODEL_CREDENTIAL_NOT_FOUND');
    }
    let reauth: unknown;
    try {
      return await this.db.withTransaction(async (db) => {
        await db.query(`SELECT set_config('lock_timeout', $1, true)`, [`${this.#lockTimeoutMs}ms`]);
        const locked = await db.query<CredentialRow>(
          `SELECT ${SECRET_COLUMNS} FROM model_credentials WHERE id=$1 AND owner_id=$2 FOR UPDATE`,
          [credentialId, this.ownerId],
        );
        const row = locked.rows[0];
        if (!row) throw new CredentialVaultError('MODEL_CREDENTIAL_NOT_FOUND');
        if (row.status !== 'active' || !row.ciphertext) throw statusError(row.status);
        const current = this.#unseal(row);

        let next: Credential | undefined;
        try {
          next = await withTimeLimit(fn(current), this.#modifyTimeLimitMs);
        } catch (error) {
          if (isReauthFailure(error)) {
            // Committed below in its own transaction: this one rolls back.
            reauth = error;
          }
          throw error;
        }
        if (next === undefined) return current;

        const secretVersion = row.secret_version + 1;
        const sealed = sealCredential(
          next,
          { ownerId: this.ownerId, credentialId, secretVersion },
          this.#env,
        );
        await db.query(
          `UPDATE model_credentials
              SET ciphertext=$3, key_version=$4, secret_version=$5, expires_at=$6,
                  updated_at=clock_timestamp()
            WHERE id=$1 AND owner_id=$2`,
          [
            credentialId,
            this.ownerId,
            sealed.ciphertext,
            sealed.keyVersion,
            secretVersion,
            expiryOf(next),
          ],
        );
        return next;
      });
    } catch (error) {
      if (reauth !== undefined) await this.#markReauthRequired(credentialId);
      if (isLockTimeout(error))
        throw new CredentialVaultError('MODEL_CREDENTIAL_BUSY', { cause: error });
      throw error;
    }
  }

  /**
   * Store a newly signed-in credential. A live credential for the same
   * provider keeps its id (selections that reference it keep working) and gets
   * the new secret; otherwise a new row is created.
   */
  async save(input: SaveCredentialInput): Promise<CredentialSummary> {
    return this.db.withTransaction((db) => this.saveWithin(db, input));
  }

  /**
   * `save` inside a caller's owner-bound transaction (sign-in completion
   * checks its session in the same transaction, plan 3.10).
   */
  async saveWithin(db: Queryable, input: SaveCredentialInput): Promise<CredentialSummary> {
    const label = sanitizeAccountLabel(input.accountLabel);
    await db.query(`SELECT set_config('lock_timeout', $1, true)`, [`${this.#lockTimeoutMs}ms`]);
    // Serialize concurrent sign-ins for one owner and provider.
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `model-credential:${this.ownerId}:${input.providerId}`,
    ]);
    const existing = await db.query<CredentialRow>(
      `SELECT ${SECRET_COLUMNS} FROM model_credentials
        WHERE owner_id=$1 AND provider_id=$2 AND status <> 'revoked' FOR UPDATE`,
      [this.ownerId, input.providerId],
    );
    const row = existing.rows[0];
    const credentialId = row?.id ?? randomUUID();
    const secretVersion = (row?.secret_version ?? 0) + 1;
    const sealed = sealCredential(
      input.credential,
      { ownerId: this.ownerId, credentialId, secretVersion },
      this.#env,
    );
    const result = row
      ? await db.query<CredentialRow>(
          `UPDATE model_credentials
              SET pi_provider_id=$3, auth_kind=$4, status='active', account_label=$5,
                  ciphertext=$6, key_version=$7, secret_version=$8, expires_at=$9,
                  updated_at=clock_timestamp()
            WHERE id=$1 AND owner_id=$2
            RETURNING ${SUMMARY_COLUMNS}`,
          [
            credentialId,
            this.ownerId,
            input.piProviderId,
            input.authKind,
            label,
            sealed.ciphertext,
            sealed.keyVersion,
            secretVersion,
            expiryOf(input.credential),
          ],
        )
      : await db.query<CredentialRow>(
          `INSERT INTO model_credentials(id, owner_id, provider_id, pi_provider_id, auth_kind,
              status, account_label, ciphertext, key_version, secret_version, expires_at)
           VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8,$9,$10)
           RETURNING ${SUMMARY_COLUMNS}`,
          [
            credentialId,
            this.ownerId,
            input.providerId,
            input.piProviderId,
            input.authKind,
            label,
            sealed.ciphertext,
            sealed.keyVersion,
            secretVersion,
            expiryOf(input.credential),
          ],
        );
    return summaryOf(result.rows[0]!);
  }

  /**
   * Disconnect: under the row lock, mark revoked and drop the ciphertext. A
   * refresh holding the lock finishes first; any later modify sees `revoked`.
   * Returns false when there was nothing to revoke.
   */
  async revoke(credentialId: string): Promise<boolean> {
    if (!UUID.safeParse(credentialId).success) return false;
    try {
      return await this.db.withTransaction(async (db) => {
        await db.query(`SELECT set_config('lock_timeout', $1, true)`, [`${this.#lockTimeoutMs}ms`]);
        const locked = await db.query<{ status: CredentialStatus }>(
          'SELECT status FROM model_credentials WHERE id=$1 AND owner_id=$2 FOR UPDATE',
          [credentialId, this.ownerId],
        );
        const status = locked.rows[0]?.status;
        if (!status || status === 'revoked') return false;
        await db.query(
          `UPDATE model_credentials
              SET status='revoked', ciphertext=NULL, revoked_at=clock_timestamp(),
                  updated_at=clock_timestamp()
            WHERE id=$1 AND owner_id=$2`,
          [credentialId, this.ownerId],
        );
        return true;
      });
    } catch (error) {
      if (isLockTimeout(error))
        throw new CredentialVaultError('MODEL_CREDENTIAL_BUSY', { cause: error });
      throw error;
    }
  }

  async #markReauthRequired(credentialId: string): Promise<void> {
    await this.db.withTransaction(async (db) => {
      await db.query(
        `UPDATE model_credentials SET status='reauth_required', updated_at=clock_timestamp()
          WHERE id=$1 AND owner_id=$2 AND status='active'`,
        [credentialId, this.ownerId],
      );
    });
  }

  #unseal(row: CredentialRow): Credential {
    return unsealCredential(
      row.ciphertext!,
      row.key_version,
      { ownerId: this.ownerId, credentialId: row.id, secretVersion: row.secret_version },
      this.#env,
    );
  }
}
