/**
 * Subscription sign-in executor (plan 3.10, P6-3). A custom pi provider drives
 * device-code and manual-code sign-ins through pi's real `Models.login`; the
 * sessions live in PGlite with the v21 schema under the web role.
 */
import { randomBytes } from 'node:crypto';
import {
  createProvider,
  lazyApi,
  type AuthInteraction,
  type LoginOptions,
  type OAuthCredential,
} from '@earendil-works/pi-ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LoginService,
  LoginSessionError,
  accountLabelOf,
  type LoginServiceDeps,
  type LoginSessionView,
} from '@/lib/model-gateway/auth/login-sessions';
import {
  configuredOAuthProviders,
  enabledOAuthProviders,
  oauthDeploymentCapable,
} from '@/lib/model-gateway/auth/policy';
import { sealedAuthContext } from '@/lib/model-gateway/credentials/auth-context';
import { CredentialVault } from '@/lib/model-gateway/credentials/vault';
import { runProviderLogin } from '@/lib/model-gateway/runtime/pi-registry';
import {
  applySql,
  openPglite,
  pgliteVault,
  prepareV21,
} from '@/tests/helpers/model-credentials-db';

const OWNER = 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'user:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
/** A catalog provider whose sign-in runs through pi provider `openai-codex`. */
const PROVIDER = 'openai-codex';
const env = { MODEL_CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString('hex') };

const ACCOUNTS = `
CREATE TABLE IF NOT EXISTS public.app_accounts (owner_id text PRIMARY KEY, status text NOT NULL);
ALTER TABLE public.app_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_accounts FORCE ROW LEVEL SECURITY;
GRANT SELECT ON TABLE public.app_accounts TO app_web;
DROP POLICY IF EXISTS app_accounts_web_select ON public.app_accounts;
CREATE POLICY app_accounts_web_select ON public.app_accounts
  FOR SELECT TO app_web USING (owner_id = app_internal.current_owner_id());
`;

function credential(tag: string, email?: string): OAuthCredential {
  return {
    type: 'oauth',
    access: `access-${tag}`,
    refresh: `refresh-${tag}`,
    expires: Date.now() + 3_600_000,
    ...(email ? { email } : {}),
  };
}

type Flow = (interaction: AuthInteraction, options?: LoginOptions) => Promise<OAuthCredential>;

/** A pi provider with only the OAuth sign-in the test scripts. */
function scriptedProvider(flow: Flow) {
  return createProvider({
    id: PROVIDER,
    auth: {
      oauth: {
        name: 'Scripted sign-in',
        login: (interaction, options) => flow(interaction, options),
        refresh: async (current) => current,
        toAuth: async (current) => ({ apiKey: current.access }),
      },
    },
    models: [],
    api: lazyApi(() => import('@earendil-works/pi-ai/api/openai-completions')),
  });
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

/** Resolve when the signal aborts (a well-behaved sign-in waiting on the user). */
function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

let db: ReturnType<typeof openPglite>;
const services: LoginService[] = [];

function service(flow: Flow, overrides: Partial<LoginServiceDeps> = {}): LoginService {
  const created = new LoginService({
    database: (owner) => pgliteVault(db.raw, owner, 'app_web'),
    login: (_piProviderId, interaction, deviceId) =>
      runProviderLogin(scriptedProvider(flow), sealedAuthContext(), interaction, deviceId),
    env,
    isProviderEnabled: () => true,
    timings: { ttlMs: 60_000, leaseMs: 5_000, heartbeatMs: 1_000, inputPollMs: 20 },
    ...overrides,
  });
  services.push(created);
  return created;
}

async function waitFor(
  read: () => Promise<LoginSessionView>,
  done: (session: LoginSessionView) => boolean,
  timeoutMs = 5_000,
): Promise<LoginSessionView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const session = await read();
    if (done(session)) return session;
    if (Date.now() > deadline) throw new Error(`session stuck in ${session.status}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function codeOf(work: Promise<unknown>): Promise<string> {
  const error = await work.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(LoginSessionError);
  return (error as LoginSessionError).code;
}

const vault = (owner = OWNER) => new CredentialVault(pgliteVault(db.raw, owner), owner, { env });

beforeEach(async () => {
  db = openPglite();
  await prepareV21(db);
  await applySql(db, ACCOUNTS);
  await db.query("INSERT INTO app_accounts VALUES ($1,'active'),($2,'active')", [OWNER, OTHER]);
});

afterEach(async () => {
  for (const created of services.splice(0)) {
    created.abandonAll();
    await created.idle();
  }
  await db.close();
});

describe('subscription sign-in sessions', () => {
  it('completes a device-code sign-in with a stable device id', async () => {
    const authorized = gate();
    const deviceIds: (string | undefined)[] = [];
    const flow: Flow = async (interaction, options) => {
      deviceIds.push(options?.getDeviceId?.());
      interaction.notify({
        type: 'device_code',
        userCode: 'ABCD-1234',
        verificationUri: 'https://auth.example.test/device',
        intervalSeconds: 5,
        expiresInSeconds: 600,
      });
      await authorized.opened;
      return credential('device', 'user@example.com');
    };
    const logins = service(flow);
    const started = await logins.start(OWNER, PROVIDER);
    expect(started.status).toBe('pending');

    const waiting = await waitFor(
      () => logins.get(OWNER, started.id),
      (session) => session.status === 'awaiting_user',
    );
    expect(waiting.challenge?.deviceCode).toEqual({
      userCode: 'ABCD-1234',
      verificationUri: 'https://auth.example.test/device',
      intervalSeconds: 5,
      expiresInSeconds: 600,
    });
    expect(waiting.challenge?.prompt).toBeUndefined();

    authorized.open();
    const done = await waitFor(
      () => logins.get(OWNER, started.id),
      (session) => session.status === 'complete',
    );
    expect(done.credentialId).toBeTruthy();
    expect(done.challenge).toBeNull();
    const [stored] = await vault().list();
    expect(stored).toMatchObject({
      id: done.credentialId,
      providerId: PROVIDER,
      piProviderId: PROVIDER,
      authKind: 'oauth',
      accountLabel: 'u***@example.com',
    });
    expect((await vault().read(done.credentialId!)).credential).toMatchObject({
      access: 'access-device',
    });
    expect(JSON.stringify(done)).not.toMatch(/access-|refresh-/);

    // Signing in again reuses the deployment's device id.
    const again = await logins.start(OWNER, PROVIDER);
    await waitFor(
      () => logins.get(OWNER, again.id),
      (session) => session.status === 'complete',
    );
    const persisted = await db.query('SELECT device_id FROM model_auth_settings');
    expect(deviceIds).toEqual([persisted.rows[0]?.device_id, persisted.rows[0]?.device_id]);
  });

  it('completes a manual-code sign-in from a sealed one-time input', async () => {
    const flow: Flow = async (interaction) => {
      interaction.notify({
        type: 'auth_url',
        url: 'https://auth.example.test/authorize?state=s1',
        instructions: 'Sign in, then paste the redirect URL.',
      });
      const code = await interaction.prompt({
        type: 'manual_code',
        message: 'Paste the redirect URL',
        placeholder: 'http://localhost:1455/auth/callback?code=…',
      });
      return credential(code);
    };
    const logins = service(flow);
    const started = await logins.start(OWNER, PROVIDER);
    const waiting = await waitFor(
      () => logins.get(OWNER, started.id),
      (session) => session.challenge?.prompt !== undefined,
    );
    expect(waiting.challenge).toMatchObject({
      authUrl: 'https://auth.example.test/authorize?state=s1',
      instructions: 'Sign in, then paste the redirect URL.',
      prompt: { kind: 'manual_code', message: 'Paste the redirect URL' },
    });

    await logins.submitInput(OWNER, started.id, 'the-code');
    const done = await waitFor(
      () => logins.get(OWNER, started.id),
      (session) => session.status === 'complete',
    );
    expect((await vault().read(done.credentialId!)).credential).toMatchObject({
      access: 'access-the-code',
    });
    const row = await db.query('SELECT * FROM model_auth_sessions WHERE id=$1', [started.id]);
    expect(row.rows[0]?.input_ciphertext).toBeNull();
    expect(JSON.stringify(row.rows)).not.toContain('the-code');
  });

  it('accepts one input per prompt and only while a prompt is open', async () => {
    const asked = gate();
    const flow: Flow = async (interaction) => {
      await asked.opened;
      const choice = await interaction.prompt({
        type: 'select',
        message: 'Pick a plan',
        options: [
          { id: 'plus', label: 'Plus' },
          { id: 'pro', label: 'Pro' },
        ],
      });
      return credential(choice);
    };
    // A slow poll keeps the first input unconsumed while the second arrives.
    const logins = service(flow, {
      timings: { ttlMs: 60_000, leaseMs: 5_000, heartbeatMs: 1_000, inputPollMs: 60_000 },
    });
    const started = await logins.start(OWNER, PROVIDER);
    expect(await codeOf(logins.submitInput(OWNER, started.id, 'pro'))).toBe(
      'MODEL_AUTH_INPUT_NOT_EXPECTED',
    );
    asked.open();
    await waitFor(
      () => logins.get(OWNER, started.id),
      (session) => session.challenge?.prompt?.kind === 'select',
    );
    expect(await codeOf(logins.submitInput(OWNER, started.id, 'enterprise'))).toBe(
      'MODEL_AUTH_INPUT_INVALID',
    );
    expect(await codeOf(logins.submitInput(OWNER, started.id, ''))).toBe(
      'MODEL_AUTH_INPUT_INVALID',
    );
    expect(await codeOf(logins.submitInput(OWNER, started.id, 'x'.repeat(5000)))).toBe(
      'MODEL_AUTH_INPUT_INVALID',
    );
    await logins.submitInput(OWNER, started.id, 'pro');
    expect(await codeOf(logins.submitInput(OWNER, started.id, 'plus'))).toBe(
      'MODEL_AUTH_INPUT_PENDING',
    );
    await logins.cancel(OWNER, started.id);
    expect(await codeOf(logins.submitInput(OWNER, started.id, 'plus'))).toBe(
      'MODEL_AUTH_SESSION_CLOSED',
    );
  });

  it('cancels a sign-in in progress', async () => {
    const logins = service(async (interaction) => {
      interaction.notify({ type: 'auth_url', url: 'https://auth.example.test/a' });
      return untilAborted(interaction.signal!);
    });
    const started = await logins.start(OWNER, PROVIDER);
    await waitFor(
      () => logins.get(OWNER, started.id),
      (session) => session.status === 'awaiting_user',
    );
    expect((await logins.cancel(OWNER, started.id)).status).toBe('cancelled');
    await logins.idle();
    expect(logins.runningCount).toBe(0);
    expect((await logins.get(OWNER, started.id)).status).toBe('cancelled');
    expect(await vault().list()).toEqual([]);
  });

  it('expires a sign-in that outlives its TTL', async () => {
    const logins = service(async (interaction) => untilAborted(interaction.signal!), {
      timings: { ttlMs: 300, leaseMs: 5_000, heartbeatMs: 1_000, inputPollMs: 20 },
    });
    const started = await logins.start(OWNER, PROVIDER);
    await logins.idle();
    const ended = await logins.get(OWNER, started.id);
    expect(ended.status).toBe('expired');
    expect(ended.errorCode).toBeNull();
    expect(await vault().list()).toEqual([]);
  });

  it('marks a session interrupted when its executor stops', async () => {
    const hanging = gate();
    const first = service(async () => hanging.opened.then(() => credential('late')), {
      timings: { ttlMs: 60_000, leaseMs: 300, heartbeatMs: 100, inputPollMs: 20 },
    });
    const started = await first.start(OWNER, PROVIDER);
    // The process exits: no further writes, the lease lapses.
    first.abandonAll();
    await first.idle();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const restarted = service(async () => credential('unused'));
    expect((await restarted.get(OWNER, started.id)).status).toBe('interrupted');
    hanging.open();
    expect(await vault().list()).toEqual([]);
  });

  it('drops a sign-in result that arrives after the session was cancelled', async () => {
    const release = gate();
    // The flow ignores cancellation and finishes late; its executor only
    // learns about the cancel from the database.
    const executor = service(async () => release.opened.then(() => credential('late')), {
      timings: { ttlMs: 60_000, leaseMs: 60_000, heartbeatMs: 60_000, inputPollMs: 20 },
    });
    const started = await executor.start(OWNER, PROVIDER);
    const otherReplica = service(async () => credential('unused'));
    expect((await otherReplica.cancel(OWNER, started.id)).status).toBe('cancelled');
    release.open();
    await executor.idle();
    expect((await executor.get(OWNER, started.id)).status).toBe('cancelled');
    expect(await vault().list()).toEqual([]);
  });

  it('starting again replaces the open session for that provider', async () => {
    const logins = service(async (interaction) => untilAborted(interaction.signal!));
    const first = await logins.start(OWNER, PROVIDER);
    const second = await logins.start(OWNER, PROVIDER);
    expect((await logins.get(OWNER, first.id)).status).toBe('cancelled');
    expect((await logins.get(OWNER, second.id)).status).toBe('pending');
    const open = await db.query(
      "SELECT count(*)::int AS n FROM model_auth_sessions WHERE status IN ('pending','awaiting_user')",
    );
    expect(open.rows[0]?.n).toBe(1);
  });

  it('refuses disabled providers and caps sessions per process', async () => {
    const disabled = service(async () => credential('x'), { isProviderEnabled: () => false });
    expect(await codeOf(disabled.start(OWNER, PROVIDER))).toBe('MODEL_AUTH_PROVIDER_UNAVAILABLE');
    const enabled = service(async () => credential('x'));
    // An application id without an OAuth sign-in is never startable.
    expect(await codeOf(enabled.start(OWNER, 'deepseek'))).toBe('MODEL_AUTH_PROVIDER_UNAVAILABLE');

    const capped = service(async (interaction) => untilAborted(interaction.signal!), {
      maxSessions: 1,
    });
    await capped.start(OWNER, PROVIDER);
    expect(await codeOf(capped.start(OTHER, PROVIDER))).toBe('MODEL_AUTH_BUSY');
  });

  it('does not store a credential for an account that is no longer active', async () => {
    const release = gate();
    const logins = service(async () => release.opened.then(() => credential('x')));
    const started = await logins.start(OWNER, PROVIDER);
    await db.query("UPDATE app_accounts SET status='deleting' WHERE owner_id=$1", [OWNER]);
    release.open();
    await logins.idle();
    const ended = await logins.get(OWNER, started.id);
    expect(ended).toMatchObject({ status: 'failed', errorCode: 'MODEL_AUTH_ACCOUNT_INACTIVE' });
    expect(await vault().list()).toEqual([]);
  });

  it('keeps sessions private to their owner', async () => {
    const logins = service(async (interaction) => {
      await interaction.prompt({ type: 'text', message: 'Code' });
      return credential('x');
    });
    const started = await logins.start(OWNER, PROVIDER);
    await waitFor(
      () => logins.get(OWNER, started.id),
      (session) => session.status === 'awaiting_user',
    );
    expect(await codeOf(logins.get(OTHER, started.id))).toBe('MODEL_AUTH_SESSION_NOT_FOUND');
    expect(await codeOf(logins.submitInput(OTHER, started.id, 'x'))).toBe(
      'MODEL_AUTH_SESSION_NOT_FOUND',
    );
    expect(await codeOf(logins.cancel(OTHER, started.id))).toBe('MODEL_AUTH_SESSION_NOT_FOUND');
    expect((await logins.get(OWNER, started.id)).status).toBe('awaiting_user');
  });

  it('records a failed sign-in with a fixed code and keeps unsafe links out', async () => {
    const logins = service(async (interaction) => {
      interaction.notify({ type: 'auth_url', url: 'javascript:alert(1)' });
      interaction.notify({
        type: 'info',
        message: 'Read the terms',
        links: [
          { url: 'http://plain.example.test', label: 'plain' },
          { url: 'https://terms.example.test', label: 'terms' },
        ],
      });
      throw new Error('upstream said: token=secret-value');
    });
    const started = await logins.start(OWNER, PROVIDER);
    await logins.idle();
    const ended = await logins.get(OWNER, started.id);
    expect(ended).toMatchObject({ status: 'failed', errorCode: 'MODEL_AUTH_FAILED' });
    expect(ended.challenge?.authUrl).toBeUndefined();
    expect(ended.challenge?.info?.links).toEqual([
      { url: 'https://terms.example.test/', label: 'terms' },
    ]);
    expect(JSON.stringify(ended)).not.toContain('secret-value');
  });
});

describe('sign-in policy', () => {
  const key = randomBytes(32).toString('hex');

  it('needs hosted sign-in, a database and the credential key', () => {
    const full = { DATABASE_URL: 'postgres://db/app', MODEL_CREDENTIAL_ENCRYPTION_KEY: key };
    expect(oauthDeploymentCapable({ env: full, hostedAuth: () => true })).toBe(true);
    expect(oauthDeploymentCapable({ env: full, hostedAuth: () => false })).toBe(false);
    expect(
      oauthDeploymentCapable({ env: { ...full, DATABASE_URL: '' }, hostedAuth: () => true }),
    ).toBe(false);
    expect(
      oauthDeploymentCapable({
        env: { ...full, MODEL_CREDENTIAL_ENCRYPTION_KEY: 'x' },
        hostedAuth: () => true,
      }),
    ).toBe(false);
  });

  it('enables only listed providers that can sign in', () => {
    const listed = {
      MODEL_OAUTH_PROVIDERS: ' openai-codex, deepseek ,openai-codex,unknown,github-copilot',
    };
    expect(configuredOAuthProviders(listed)).toEqual(['openai-codex', 'github-copilot']);
    expect(configuredOAuthProviders({})).toEqual([]);
    const env = {
      ...listed,
      DATABASE_URL: 'postgres://db/app',
      MODEL_CREDENTIAL_ENCRYPTION_KEY: key,
    };
    expect(enabledOAuthProviders({ env, hostedAuth: () => true })).toEqual([
      'openai-codex',
      'github-copilot',
    ]);
    expect(enabledOAuthProviders({ env, hostedAuth: () => false })).toEqual([]);
  });

  it('masks the account label', () => {
    expect(accountLabelOf(credential('x', 'someone@example.com'))).toBe('s***@example.com');
    expect(accountLabelOf(credential('x'))).toBeNull();
    expect(accountLabelOf({ ...credential('x'), email: 'not-an-email' })).toBeNull();
  });
});
