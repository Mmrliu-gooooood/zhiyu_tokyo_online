/**
 * Signed-in accounts at call time (plan 3.10, P6-4): the gateway reads the
 * owner's credential from the vault before every attempt (worker role,
 * owner-bound), refreshes it under the row lock when it is about to expire,
 * and never sends anything when the account is disconnected or must sign in
 * again — there is no fallback to another key.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createProvider, lazyApi, type OAuthCredential } from '@earendil-works/pi-ai';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayError, userText } from '@/lib/model-gateway';
import { sealedAuthContext } from '@/lib/model-gateway/credentials/auth-context';
import { CredentialVault } from '@/lib/model-gateway/credentials/vault';
import {
  startFakeModelServer,
  type FakeModelServer,
} from '@/lib/model-gateway/testing/fake-openai-server';
import { openPglite, pgliteVault, prepareV21 } from '@/tests/helpers/model-credentials-db';
import { bindingFor, piModel, testGateway } from './helpers';

const OWNER = 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'user:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PROVIDER = 'openai-codex';
const KEY = randomBytes(32).toString('hex');
const request = { messages: [userText('Hello', 0)] };

let server: FakeModelServer;
let db: ReturnType<typeof openPglite>;
let refreshes: Array<(current: OAuthCredential) => Promise<OAuthCredential>>;
let refreshCalls: number;

/** A subscription provider whose token refresh the test scripts. */
const provider = createProvider({
  id: PROVIDER,
  auth: {
    oauth: {
      name: 'Scripted subscription',
      login: async () => {
        throw new Error('not used');
      },
      refresh: async (current) => {
        refreshCalls += 1;
        const next = refreshes.shift();
        if (!next) throw new Error('unexpected refresh');
        return next(current);
      },
      toAuth: async (current) => ({ apiKey: current.access }),
    },
  },
  models: [],
  api: lazyApi(() => import('@earendil-works/pi-ai/api/openai-completions')),
});

function oauth(tag: string, expiresInMs = 3_600_000): OAuthCredential {
  return {
    type: 'oauth',
    access: `access-${tag}`,
    refresh: `refresh-${tag}`,
    expires: Date.now() + expiresInMs,
  };
}

const vault = (owner = OWNER) => new CredentialVault(pgliteVault(db.raw, owner), owner);

async function signIn(credential: OAuthCredential, providerId = PROVIDER) {
  return vault().save({ providerId, piProviderId: providerId, authKind: 'oauth', credential });
}

/** A vault binding for the fake server (an OpenAI-compatible stream). */
async function vaultBinding(credentialId: string, ownerId = OWNER) {
  const model = await piModel('deepseek', 'deepseek-flash');
  return bindingFor(
    'deepseek',
    'deepseek-flash',
    server.origin,
    {
      providerId: PROVIDER,
      modelString: `${PROVIDER}:deepseek-flash`,
      model: { ...model, provider: PROVIDER, baseUrl: server.origin },
      funding: { kind: 'subscription', credentialId },
      endpoint: 'official',
    },
    { kind: 'vault', ownerId, credentialId },
  );
}

function gateway() {
  return testGateway({
    resolveProvider: async () => ({ provider, authContext: sealedAuthContext() }),
    // The generation worker's role reads the credential, owner-bound.
    credentialDatabase: async (owner) => pgliteVault(db.raw, owner, 'app_worker'),
  });
}

async function call(binding: Awaited<ReturnType<typeof vaultBinding>>) {
  const harness = gateway();
  const outcome = await harness.gateway
    .complete(binding, request, { source: 'test' })
    .then((result) => ({ result, error: undefined }))
    .catch((error: unknown) => ({ result: undefined, error: error as GatewayError }));
  return { ...outcome, harness };
}

beforeAll(async () => {
  server = await startFakeModelServer();
  server.setHandler(() => ({ kind: 'auto', text: 'ok' }));
}, 60_000);
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  vi.stubEnv('MODEL_CREDENTIAL_ENCRYPTION_KEY', KEY);
  // Platform and operator keys are present: none may ever be used instead.
  vi.stubEnv('DEEPSEEK_API_KEY', 'sk-platform-key');
  vi.stubEnv('OPENAI_API_KEY', 'sk-operator-key');
  server.reset();
  server.setHandler(() => ({ kind: 'auto', text: 'ok' }));
  refreshes = [];
  refreshCalls = 0;
  db = openPglite();
  await prepareV21(db);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await db.close();
});

describe('signed-in account calls', () => {
  it('sends the current token and records subscription funding', async () => {
    const { id } = await signIn(oauth('one'));
    const { result, error, harness } = await call(await vaultBinding(id));
    expect(error).toBeUndefined();
    expect(result?.text).toBe('ok');
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]!.headers.authorization).toBe('Bearer access-one');
    expect(refreshCalls).toBe(0);
    expect(harness.usage[0]).toMatchObject({
      fundingKind: 'subscription',
      credentialKind: 'vault',
      status: 'ok',
    });
    expect(JSON.stringify(harness.calls)).not.toContain('access-one');
  });

  it('refreshes an expiring token once under the lock and keeps using it', async () => {
    const { id } = await signIn(oauth('old', 60_000));
    refreshes.push(async () => oauth('fresh'));
    const first = await call(await vaultBinding(id));
    expect(first.error).toBeUndefined();
    expect(server.requests.at(-1)!.headers.authorization).toBe('Bearer access-fresh');
    expect(refreshCalls).toBe(1);
    const stored = await db.query('SELECT secret_version FROM model_credentials WHERE id=$1', [id]);
    expect(stored.rows[0]?.secret_version).toBe(2);

    const second = await call(await vaultBinding(id));
    expect(second.error).toBeUndefined();
    expect(server.requests.at(-1)!.headers.authorization).toBe('Bearer access-fresh');
    expect(refreshCalls).toBe(1);
  });

  it('stops before sending when the provider rejects the refresh token', async () => {
    const { id } = await signIn(oauth('old', 60_000));
    refreshes.push(async () => {
      throw new Error('OAuth refresh failed (HTTP 400): invalid_grant');
    });
    const { error } = await call(await vaultBinding(id));
    expect(error).toBeInstanceOf(GatewayError);
    expect(error).toMatchObject({ code: 'MODEL_REAUTH_REQUIRED', requestSent: false });
    expect(server.requests).toHaveLength(0);
    expect((await vault().get(id))?.status).toBe('reauth_required');

    const again = await call(await vaultBinding(id));
    expect(again.error).toMatchObject({ code: 'MODEL_REAUTH_REQUIRED' });
    expect(server.requests).toHaveLength(0);
    expect(refreshCalls).toBe(1);
  });

  it('retries a temporary refresh failure and keeps the account', async () => {
    const { id } = await signIn(oauth('old', 60_000));
    refreshes.push(async () => {
      throw Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' });
    });
    refreshes.push(async () => oauth('fresh'));
    const { error, harness } = await call(await vaultBinding(id));
    expect(error).toBeUndefined();
    expect(refreshCalls).toBe(2);
    expect(harness.sleeps).toHaveLength(1);
    expect(server.requests.at(-1)!.headers.authorization).toBe('Bearer access-fresh');
    expect((await vault().get(id))?.status).toBe('active');
  });

  it('never sends for a disconnected account, another owner or another provider', async () => {
    const { id } = await signIn(oauth('one'));
    expect(await vault().revoke(id)).toBe(true);
    const revoked = await call(await vaultBinding(id));
    expect(revoked.error).toMatchObject({ code: 'MODEL_AUTH_FAILED', requestSent: false });

    const { id: live } = await signIn(oauth('two'));
    const foreign = await call(await vaultBinding(live, OTHER));
    expect(foreign.error).toMatchObject({ code: 'MODEL_AUTH_FAILED', requestSent: false });

    const { id: copilot } = await signIn(oauth('three'), 'github-copilot');
    const mismatch = await call(await vaultBinding(copilot));
    expect(mismatch.error).toMatchObject({ code: 'MODEL_AUTH_FAILED', requestSent: false });

    const missing = await call(await vaultBinding(randomUUID()));
    expect(missing.error).toMatchObject({ code: 'MODEL_AUTH_FAILED' });

    expect(server.requests).toHaveLength(0);
  });

  it('reports a deployment without the credential key as a configuration error', async () => {
    const { id } = await signIn(oauth('one'));
    vi.stubEnv('MODEL_CREDENTIAL_ENCRYPTION_KEY', '');
    const { error } = await call(await vaultBinding(id));
    expect(error).toMatchObject({ code: 'MODEL_CONFIGURATION', requestSent: false });
    expect(server.requests).toHaveLength(0);
  });
});
