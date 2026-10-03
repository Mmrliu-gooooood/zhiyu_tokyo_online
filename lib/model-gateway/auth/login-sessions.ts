/**
 * Subscription sign-in executor (plan 3.10, P6-3).
 *
 * A sign-in runs in the long-lived web process that started it (the same
 * process model as the PRO Agent runner). Its state lives in
 * model_auth_sessions so any replica can serve the browser:
 *
 * - `notify` events (auth URL, device code, progress) are written to the
 *   session's non-secret challenge;
 * - `prompt` publishes what the user must enter and waits for a sealed,
 *   one-time input that any replica may store; the executor consumes it;
 * - the executor renews a short lease. A session whose lease lapsed (the
 *   process stopped) reads as `interrupted`; one past its 10-minute TTL as
 *   `expired`. Cancelling from any replica stops the executor at its next
 *   lease renewal or input poll.
 * - On success the credential is stored in one short transaction that first
 *   re-checks the session is still open and owned by this executor and that
 *   the account is active, so a late result can never create a credential.
 *
 * At most one open session per owner and provider (starting again replaces
 * it) and at most 20 running in one process.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AuthEvent, AuthInteraction, AuthPrompt, Credential } from '@earendil-works/pi-ai';
import { createLogger } from '@/lib/logger';
import {
  CredentialVault,
  sealText,
  unsealText,
  type CredentialSummary,
  type Queryable,
  type VaultDatabase,
} from '../credentials/vault';
import { isOAuthProviderEnabled, oauthPiProviderId } from './policy';

const log = createLogger('ModelAuth');

export const SESSION_TTL_MS = 10 * 60_000;
export const MAX_PROCESS_SESSIONS = 20;
export const MAX_INPUT_LENGTH = 4096;
const INPUT_AAD_TAG = 'model-auth-input:v1';

export type LoginSessionStatus =
  | 'pending'
  | 'awaiting_user'
  | 'complete'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'interrupted';

const OPEN: readonly LoginSessionStatus[] = ['pending', 'awaiting_user'];

export interface LoginChallenge {
  authUrl?: string;
  instructions?: string;
  deviceCode?: {
    userCode: string;
    verificationUri: string;
    intervalSeconds?: number;
    expiresInSeconds?: number;
  };
  prompt?: {
    kind: 'text' | 'secret' | 'select' | 'manual_code';
    message: string;
    placeholder?: string;
    options?: { id: string; label: string; description?: string }[];
  };
  progress?: string;
  info?: { message: string; links?: { url: string; label?: string }[] };
}

/** What the browser sees: never a token, never the user's input. */
export interface LoginSessionView {
  id: string;
  providerId: string;
  status: LoginSessionStatus;
  challenge: LoginChallenge | null;
  errorCode: string | null;
  credentialId: string | null;
  expiresAt: string;
}

export type LoginSessionErrorCode =
  | 'MODEL_AUTH_PROVIDER_UNAVAILABLE'
  | 'MODEL_AUTH_BUSY'
  | 'MODEL_AUTH_SESSION_NOT_FOUND'
  | 'MODEL_AUTH_SESSION_CLOSED'
  | 'MODEL_AUTH_INPUT_NOT_EXPECTED'
  | 'MODEL_AUTH_INPUT_PENDING'
  | 'MODEL_AUTH_INPUT_INVALID';

const ERROR_STATUS: Record<LoginSessionErrorCode, number> = {
  MODEL_AUTH_PROVIDER_UNAVAILABLE: 404,
  MODEL_AUTH_BUSY: 429,
  MODEL_AUTH_SESSION_NOT_FOUND: 404,
  MODEL_AUTH_SESSION_CLOSED: 409,
  MODEL_AUTH_INPUT_NOT_EXPECTED: 409,
  MODEL_AUTH_INPUT_PENDING: 409,
  MODEL_AUTH_INPUT_INVALID: 400,
};

export class LoginSessionError extends Error {
  readonly status: number;
  constructor(readonly code: LoginSessionErrorCode) {
    super(code);
    this.name = 'LoginSessionError';
    this.status = ERROR_STATUS[code];
  }
}

/** Run one provider's OAuth sign-in and return the credential it produced. */
export type ProviderLoginRunner = (
  piProviderId: string,
  interaction: AuthInteraction,
  deviceId: string,
) => Promise<Credential>;

type Env = Readonly<Record<string, string | undefined>>;

export interface LoginServiceDeps {
  /** Owner-bound transaction runner for the web role. */
  database: (ownerId: string) => VaultDatabase;
  login: ProviderLoginRunner;
  env?: Env;
  isProviderEnabled?: (providerId: string) => boolean;
  /** Whether the owner's account may still receive a credential. */
  ownerActive?: (db: Queryable, ownerId: string) => Promise<boolean>;
  timings?: Partial<{ ttlMs: number; leaseMs: number; heartbeatMs: number; inputPollMs: number }>;
  maxSessions?: number;
}

interface SessionRow extends Record<string, unknown> {
  id: string;
  provider_id: string;
  status: LoginSessionStatus;
  challenge: LoginChallenge | null;
  input_ciphertext: string | null;
  executor_id: string | null;
  credential_id: string | null;
  error_code: string | null;
  expires_at: Date | string;
}

const COLUMNS =
  'id, provider_id, status, challenge, input_ciphertext, executor_id, credential_id, error_code, expires_at';
const UUID = z.uuid();

function view(row: SessionRow): LoginSessionView {
  return {
    id: row.id,
    providerId: row.provider_id,
    status: row.status,
    challenge: row.challenge,
    errorCode: row.error_code,
    credentialId: row.credential_id,
    expiresAt: (row.expires_at instanceof Date
      ? row.expires_at
      : new Date(row.expires_at)
    ).toISOString(),
  };
}

/** Only https links reach the browser (no javascript:, data: or plain http). */
function safeUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function clip(value: string | undefined, max = 2000): string | undefined {
  return value === undefined ? undefined : value.slice(0, max);
}

/** Masked e-mail for the account label, when the provider reports one. */
export function accountLabelOf(credential: Credential): string | null {
  const email = (credential as { email?: unknown }).email;
  if (typeof email !== 'string') return null;
  const at = email.indexOf('@');
  if (at < 1) return null;
  return `${email[0]}***${email.slice(at)}`.slice(0, 200);
}

/** Why a running sign-in stopped without a result. */
class SessionEnd extends Error {
  constructor(readonly outcome: 'expired' | 'closed') {
    super(outcome);
  }
}

function abortableDelay(ms: number, signals: (AbortSignal | undefined)[]): Promise<void> {
  const signal = AbortSignal.any(signals.filter((item): item is AbortSignal => Boolean(item)));
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Error name and code only: upstream sign-in messages can echo response bodies. */
function safeError(error: unknown): { name: string; code?: string } {
  const code = (error as { code?: unknown })?.code;
  return {
    name: error instanceof Error ? error.name : typeof error,
    ...(typeof code === 'string' ? { code } : {}),
  };
}

async function defaultOwnerActive(db: Queryable, ownerId: string): Promise<boolean> {
  const result = await db.query<{ status: string }>(
    'SELECT status FROM app_accounts WHERE owner_id=$1',
    [ownerId],
  );
  return result.rows[0]?.status === 'active';
}

export class LoginService {
  readonly executorId = randomUUID();
  readonly #deps: LoginServiceDeps;
  readonly #env: Env;
  readonly #ttlMs: number;
  readonly #leaseMs: number;
  readonly #heartbeatMs: number;
  readonly #inputPollMs: number;
  readonly #maxSessions: number;
  readonly #running = new Map<string, { controller: AbortController; done: Promise<void> }>();
  #deviceId: Promise<string> | undefined;

  constructor(deps: LoginServiceDeps) {
    this.#deps = deps;
    this.#env = deps.env ?? process.env;
    this.#ttlMs = deps.timings?.ttlMs ?? SESSION_TTL_MS;
    this.#leaseMs = deps.timings?.leaseMs ?? 30_000;
    this.#heartbeatMs = deps.timings?.heartbeatMs ?? 10_000;
    this.#inputPollMs = deps.timings?.inputPollMs ?? 1_000;
    this.#maxSessions = deps.maxSessions ?? MAX_PROCESS_SESSIONS;
  }

  async start(ownerId: string, providerId: string): Promise<LoginSessionView> {
    const enabled = this.#deps.isProviderEnabled ?? ((id: string) => isOAuthProviderEnabled(id));
    const piProviderId = oauthPiProviderId(providerId);
    if (!enabled(providerId) || !piProviderId) {
      throw new LoginSessionError('MODEL_AUTH_PROVIDER_UNAVAILABLE');
    }
    if (this.#running.size >= this.#maxSessions) throw new LoginSessionError('MODEL_AUTH_BUSY');
    const deviceId = await this.#resolveDeviceId(ownerId);

    const id = randomUUID();
    const { row, replaced } = await this.#db(ownerId).withTransaction(async (db) => {
      await this.#sweep(db, ownerId);
      // Starting again replaces the open session for this provider.
      const closed = await db.query<{ id: string }>(
        `UPDATE model_auth_sessions
            SET status='cancelled', input_ciphertext=NULL, updated_at=clock_timestamp()
          WHERE owner_id=$1 AND provider_id=$2 AND status IN ('pending','awaiting_user')
          RETURNING id`,
        [ownerId, providerId],
      );
      const inserted = await db.query<SessionRow>(
        `INSERT INTO model_auth_sessions(id, owner_id, provider_id, status, executor_id,
            lease_until, expires_at)
         VALUES ($1,$2,$3,'pending',$4,
            clock_timestamp() + make_interval(secs => $5::double precision / 1000),
            clock_timestamp() + make_interval(secs => $6::double precision / 1000))
         RETURNING ${COLUMNS}`,
        [id, ownerId, providerId, this.executorId, this.#leaseMs, this.#ttlMs],
      );
      return { row: inserted.rows[0]!, replaced: closed.rows.map((item) => item.id) };
    });
    for (const previous of replaced)
      this.#running.get(previous)?.controller.abort(new SessionEnd('closed'));

    const controller = new AbortController();
    const done = this.#run(ownerId, id, providerId, piProviderId, deviceId, controller).finally(
      () => this.#running.delete(id),
    );
    this.#running.set(id, { controller, done });
    return view(row);
  }

  async get(ownerId: string, sessionId: string): Promise<LoginSessionView> {
    if (!UUID.safeParse(sessionId).success)
      throw new LoginSessionError('MODEL_AUTH_SESSION_NOT_FOUND');
    return this.#db(ownerId).withTransaction(async (db) => {
      await this.#sweep(db, ownerId);
      const result = await db.query<SessionRow>(
        `SELECT ${COLUMNS} FROM model_auth_sessions WHERE id=$1 AND owner_id=$2`,
        [sessionId, ownerId],
      );
      if (!result.rows[0]) throw new LoginSessionError('MODEL_AUTH_SESSION_NOT_FOUND');
      return view(result.rows[0]);
    });
  }

  /** Store the user's one-time answer to the current prompt (any replica). */
  async submitInput(ownerId: string, sessionId: string, value: unknown): Promise<LoginSessionView> {
    if (!UUID.safeParse(sessionId).success)
      throw new LoginSessionError('MODEL_AUTH_SESSION_NOT_FOUND');
    if (typeof value !== 'string' || !value.trim() || value.length > MAX_INPUT_LENGTH) {
      throw new LoginSessionError('MODEL_AUTH_INPUT_INVALID');
    }
    return this.#db(ownerId).withTransaction(async (db) => {
      await this.#sweep(db, ownerId);
      const locked = await db.query<SessionRow>(
        `SELECT ${COLUMNS} FROM model_auth_sessions WHERE id=$1 AND owner_id=$2 FOR UPDATE`,
        [sessionId, ownerId],
      );
      const row = locked.rows[0];
      if (!row) throw new LoginSessionError('MODEL_AUTH_SESSION_NOT_FOUND');
      if (!OPEN.includes(row.status)) throw new LoginSessionError('MODEL_AUTH_SESSION_CLOSED');
      const prompt = row.challenge?.prompt;
      if (row.status !== 'awaiting_user' || !prompt) {
        throw new LoginSessionError('MODEL_AUTH_INPUT_NOT_EXPECTED');
      }
      if (row.input_ciphertext) throw new LoginSessionError('MODEL_AUTH_INPUT_PENDING');
      if (prompt.kind === 'select' && !prompt.options?.some((option) => option.id === value)) {
        throw new LoginSessionError('MODEL_AUTH_INPUT_INVALID');
      }
      const sealed = sealText(value.trim(), [INPUT_AAD_TAG, ownerId, sessionId], this.#env);
      const updated = await db.query<SessionRow>(
        `UPDATE model_auth_sessions SET input_ciphertext=$3, updated_at=clock_timestamp()
          WHERE id=$1 AND owner_id=$2 RETURNING ${COLUMNS}`,
        [sessionId, ownerId, sealed.ciphertext],
      );
      return view(updated.rows[0]!);
    });
  }

  async cancel(ownerId: string, sessionId: string): Promise<LoginSessionView> {
    if (!UUID.safeParse(sessionId).success)
      throw new LoginSessionError('MODEL_AUTH_SESSION_NOT_FOUND');
    const row = await this.#db(ownerId).withTransaction(async (db) => {
      await db.query(
        `UPDATE model_auth_sessions
            SET status='cancelled', input_ciphertext=NULL, updated_at=clock_timestamp()
          WHERE id=$1 AND owner_id=$2 AND status IN ('pending','awaiting_user')`,
        [sessionId, ownerId],
      );
      const result = await db.query<SessionRow>(
        `SELECT ${COLUMNS} FROM model_auth_sessions WHERE id=$1 AND owner_id=$2`,
        [sessionId, ownerId],
      );
      return result.rows[0];
    });
    if (!row) throw new LoginSessionError('MODEL_AUTH_SESSION_NOT_FOUND');
    this.#running.get(sessionId)?.controller.abort(new SessionEnd('closed'));
    return view(row);
  }

  /** Wait for every running sign-in of this process to settle (tests, shutdown). */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.#running.values()].map((entry) => entry.done));
  }

  /**
   * Stop every running sign-in without writing anything, as a process exit
   * would. Their sessions read as interrupted once the lease lapses.
   */
  abandonAll(): void {
    for (const entry of this.#running.values()) entry.controller.abort(new SessionEnd('closed'));
  }

  get runningCount(): number {
    return this.#running.size;
  }

  #db(ownerId: string): VaultDatabase {
    return this.#deps.database(ownerId);
  }

  /** Close this owner's open sessions whose executor stopped or whose TTL passed. */
  async #sweep(db: Queryable, ownerId: string): Promise<void> {
    await db.query(
      `UPDATE model_auth_sessions
          SET status = CASE WHEN expires_at <= clock_timestamp() THEN 'expired' ELSE 'interrupted' END,
              input_ciphertext=NULL, updated_at=clock_timestamp()
        WHERE owner_id=$1 AND status IN ('pending','awaiting_user')
          AND (expires_at <= clock_timestamp() OR lease_until IS NULL OR lease_until < clock_timestamp())`,
      [ownerId],
    );
  }

  /** Deployment-stable device id: MODEL_OAUTH_DEVICE_ID, else one shared database row. */
  #resolveDeviceId(ownerId: string): Promise<string> {
    const configured = this.#env.MODEL_OAUTH_DEVICE_ID?.trim();
    if (configured && UUID.safeParse(configured).success) return Promise.resolve(configured);
    this.#deviceId ??= this.#db(ownerId)
      .withTransaction(async (db) => {
        await db.query(
          'INSERT INTO model_auth_settings(id, device_id) VALUES (1,$1) ON CONFLICT (id) DO NOTHING',
          [randomUUID()],
        );
        const result = await db.query<{ device_id: string }>(
          'SELECT device_id FROM model_auth_settings WHERE id=1',
        );
        return result.rows[0]!.device_id;
      })
      .catch((error: unknown) => {
        this.#deviceId = undefined;
        throw error;
      });
    return this.#deviceId;
  }

  async #run(
    ownerId: string,
    sessionId: string,
    providerId: string,
    piProviderId: string,
    deviceId: string,
    controller: AbortController,
  ): Promise<void> {
    const signal = controller.signal;
    const challenge: LoginChallenge = {};
    let writes: Promise<unknown> = Promise.resolve();
    const publish = (status: 'pending' | 'awaiting_user') => {
      const snapshot = JSON.stringify(challenge);
      writes = writes
        .then(() =>
          this.#db(ownerId).withTransaction((db) =>
            db.query(
              `UPDATE model_auth_sessions SET challenge=$4::jsonb, status=$3, updated_at=clock_timestamp()
                WHERE id=$1 AND owner_id=$2 AND executor_id=$5 AND status IN ('pending','awaiting_user')`,
              [sessionId, ownerId, status, snapshot, this.executorId],
            ),
          ),
        )
        .catch((error: unknown) => log.warn('sign-in challenge update failed', safeError(error)));
      return writes;
    };

    const ttl = setTimeout(() => controller.abort(new SessionEnd('expired')), this.#ttlMs);
    const heartbeat = setInterval(() => {
      void this.#db(ownerId)
        .withTransaction((db) =>
          db.query(
            `UPDATE model_auth_sessions
                SET lease_until = clock_timestamp() + make_interval(secs => $4::double precision / 1000)
              WHERE id=$1 AND owner_id=$2 AND executor_id=$3 AND status IN ('pending','awaiting_user')
              RETURNING id`,
            [sessionId, ownerId, this.executorId, this.#leaseMs],
          ),
        )
        .then((result) => {
          // Cancelled or replaced elsewhere: stop this sign-in.
          if (!result.rows.length) controller.abort(new SessionEnd('closed'));
        })
        .catch(() => undefined);
    }, this.#heartbeatMs);

    const interaction: AuthInteraction = {
      signal,
      notify: (event: AuthEvent) => {
        if (event.type === 'auth_url') {
          const url = safeUrl(event.url);
          if (!url) return;
          challenge.authUrl = url;
          challenge.instructions = clip(event.instructions);
          void publish('awaiting_user');
        } else if (event.type === 'device_code') {
          const verificationUri = safeUrl(event.verificationUri);
          if (!verificationUri) return;
          challenge.deviceCode = {
            userCode: clip(event.userCode, 100)!,
            verificationUri,
            intervalSeconds: event.intervalSeconds,
            expiresInSeconds: event.expiresInSeconds,
          };
          void publish('awaiting_user');
        } else if (event.type === 'progress') {
          challenge.progress = clip(event.message);
          void publish(challenge.authUrl || challenge.deviceCode ? 'awaiting_user' : 'pending');
        } else if (event.type === 'info') {
          challenge.info = {
            message: clip(event.message)!,
            links: event.links
              ?.map((link) => ({ url: safeUrl(link.url), label: clip(link.label, 200) }))
              .filter((link): link is { url: string; label: string | undefined } =>
                Boolean(link.url),
              ),
          };
          void publish(challenge.authUrl || challenge.deviceCode ? 'awaiting_user' : 'pending');
        }
      },
      prompt: async (prompt: AuthPrompt) => {
        challenge.prompt = {
          kind: prompt.type,
          message: clip(prompt.message)!,
          placeholder: 'placeholder' in prompt ? clip(prompt.placeholder, 200) : undefined,
          options:
            prompt.type === 'select'
              ? prompt.options.map((option) => ({
                  id: option.id,
                  label: clip(option.label, 200)!,
                  description: clip(option.description, 500),
                }))
              : undefined,
        };
        await publish('awaiting_user');
        try {
          return await this.#awaitInput(ownerId, sessionId, [signal, prompt.signal]);
        } finally {
          delete challenge.prompt;
        }
      },
    };

    try {
      const credential = await this.#deps.login(piProviderId, interaction, deviceId);
      await writes;
      await this.#complete(ownerId, sessionId, providerId, piProviderId, credential);
    } catch (error) {
      await writes;
      const reason = signal.aborted ? signal.reason : error;
      if (reason instanceof SessionEnd && reason.outcome === 'closed') return;
      const expired = reason instanceof SessionEnd && reason.outcome === 'expired';
      await this.#finish(
        ownerId,
        sessionId,
        expired ? 'expired' : 'failed',
        expired ? null : 'MODEL_AUTH_FAILED',
      );
      if (!expired) log.warn('subscription sign-in failed', { providerId, ...safeError(error) });
    } finally {
      clearTimeout(ttl);
      clearInterval(heartbeat);
    }
  }

  /** Poll for the sealed input, consume it once, and return it. */
  async #awaitInput(
    ownerId: string,
    sessionId: string,
    signals: (AbortSignal | undefined)[],
  ): Promise<string> {
    for (;;) {
      const sealed = await this.#db(ownerId).withTransaction(async (db) => {
        const locked = await db.query<SessionRow>(
          `SELECT ${COLUMNS} FROM model_auth_sessions WHERE id=$1 AND owner_id=$2 FOR UPDATE`,
          [sessionId, ownerId],
        );
        const row = locked.rows[0];
        if (!row || !OPEN.includes(row.status) || row.executor_id !== this.executorId) {
          throw new SessionEnd('closed');
        }
        if (!row.input_ciphertext) return undefined;
        await db.query(
          `UPDATE model_auth_sessions SET input_ciphertext=NULL, status='pending',
              updated_at=clock_timestamp()
            WHERE id=$1 AND owner_id=$2`,
          [sessionId, ownerId],
        );
        return row.input_ciphertext;
      });
      if (sealed) return unsealText(sealed, [INPUT_AAD_TAG, ownerId, sessionId], this.#env);
      await abortableDelay(this.#inputPollMs, signals);
    }
  }

  async #complete(
    ownerId: string,
    sessionId: string,
    providerId: string,
    piProviderId: string,
    credential: Credential,
  ): Promise<CredentialSummary | undefined> {
    const vault = new CredentialVault(this.#db(ownerId), ownerId, { env: this.#env });
    const ownerActive = this.#deps.ownerActive ?? defaultOwnerActive;
    const outcome = await this.#db(ownerId).withTransaction(async (db) => {
      const locked = await db.query<SessionRow>(
        `SELECT ${COLUMNS} FROM model_auth_sessions WHERE id=$1 AND owner_id=$2 FOR UPDATE`,
        [sessionId, ownerId],
      );
      const row = locked.rows[0];
      // Cancelled, replaced, expired or taken over: a late result is dropped.
      if (!row || !OPEN.includes(row.status) || row.executor_id !== this.executorId) {
        return { kind: 'dropped' as const };
      }
      const expired = await db.query<{ expired: boolean }>(
        'SELECT expires_at <= clock_timestamp() AS expired FROM model_auth_sessions WHERE id=$1',
        [sessionId],
      );
      if (expired.rows[0]?.expired) return { kind: 'expired' as const };
      if (!(await ownerActive(db, ownerId))) return { kind: 'inactive' as const };
      const summary = await vault.saveWithin(db, {
        providerId,
        piProviderId,
        authKind: 'oauth',
        credential,
        accountLabel: accountLabelOf(credential),
      });
      await db.query(
        `UPDATE model_auth_sessions
            SET status='complete', credential_id=$3, challenge=NULL, input_ciphertext=NULL,
                error_code=NULL, updated_at=clock_timestamp()
          WHERE id=$1 AND owner_id=$2`,
        [sessionId, ownerId, summary.id],
      );
      return { kind: 'saved' as const, summary };
    });
    if (outcome.kind === 'expired') await this.#finish(ownerId, sessionId, 'expired', null);
    if (outcome.kind === 'inactive') {
      await this.#finish(ownerId, sessionId, 'failed', 'MODEL_AUTH_ACCOUNT_INACTIVE');
    }
    return outcome.kind === 'saved' ? outcome.summary : undefined;
  }

  async #finish(
    ownerId: string,
    sessionId: string,
    status: 'failed' | 'expired',
    errorCode: string | null,
  ): Promise<void> {
    await this.#db(ownerId)
      .withTransaction((db) =>
        db.query(
          `UPDATE model_auth_sessions
              SET status=$3, error_code=$4, input_ciphertext=NULL, updated_at=clock_timestamp()
            WHERE id=$1 AND owner_id=$2 AND executor_id=$5 AND status IN ('pending','awaiting_user')`,
          [sessionId, ownerId, status, errorCode, this.executorId],
        ),
      )
      .catch((error: unknown) => log.warn('sign-in session close failed', safeError(error)));
  }
}
