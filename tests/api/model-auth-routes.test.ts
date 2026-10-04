/**
 * Credential and sign-in API guards (plan 3.10, P6-3): hidden unless the
 * deployment can hold credentials, never cached, fixed error codes only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const capable = vi.hoisted(() => ({ value: true }));
const service = vi.hoisted(() => ({
  start: vi.fn(),
  current: vi.fn(),
  get: vi.fn(),
  submitInput: vi.fn(),
  cancel: vi.fn(),
}));
const vault = vi.hoisted(() => ({ list: vi.fn(), revoke: vi.fn() }));

vi.mock('@/lib/model-gateway/auth/policy', () => ({
  oauthDeploymentCapable: () => capable.value,
}));
vi.mock('@/lib/server/agent-runtime/with-owner', () => ({
  withRequestOwnerId: (_req: Request, handler: (owner: string, headers: Headers) => unknown) =>
    handler('user:owner-a', new Headers()),
}));
vi.mock('@/lib/model-gateway/auth/service', () => ({
  getLoginService: () => service,
  webCredentialVault: () => vault,
}));

import { LoginSessionError } from '@/lib/model-gateway/auth/login-sessions';
import { CredentialVaultError } from '@/lib/model-gateway/credentials/vault';
import { GET as listCredentials } from '@/app/api/model-credentials/route';
import { DELETE as revokeCredential } from '@/app/api/model-credentials/[id]/route';
import { POST as startSignIn } from '@/app/api/model-auth/[providerId]/start/route';
import { GET as currentSignIn } from '@/app/api/model-auth/[providerId]/session/route';
import { POST as submitInput } from '@/app/api/model-auth/sessions/[id]/input/route';
import { GET as getSession } from '@/app/api/model-auth/sessions/[id]/route';

const params = <T>(value: T) => ({ params: Promise.resolve(value) });
const request = (body?: string, headers: Record<string, string> = {}) =>
  new Request('https://zhiyu.test/api/x', {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body,
  });

afterEach(() => {
  capable.value = true;
  vi.clearAllMocks();
});

describe('model auth routes', () => {
  it('are hidden when the deployment cannot hold credentials', async () => {
    capable.value = false;
    const response = await listCredentials(request());
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(vault.list).not.toHaveBeenCalled();
  });

  it('list credentials without caching', async () => {
    vault.list.mockResolvedValue([{ id: 'c1', providerId: 'openai-codex', status: 'active' }]);
    const response = await listCredentials(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      credentials: [{ id: 'c1', providerId: 'openai-codex', status: 'active' }],
    });
  });

  it('map known errors to fixed codes and hide unexpected ones', async () => {
    service.start.mockRejectedValueOnce(new LoginSessionError('MODEL_AUTH_PROVIDER_UNAVAILABLE'));
    const unavailable = await startSignIn(request('{}'), params({ providerId: 'deepseek' }));
    expect(unavailable.status).toBe(404);
    expect(await unavailable.json()).toEqual({ error: 'MODEL_AUTH_PROVIDER_UNAVAILABLE' });

    vault.revoke.mockRejectedValueOnce(new CredentialVaultError('MODEL_CREDENTIAL_BUSY'));
    const busy = await revokeCredential(request('{}'), params({ id: 'c1' }));
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ error: 'MODEL_CREDENTIAL_BUSY' });

    service.get.mockRejectedValueOnce(new Error('connection to db://user:pw@host failed'));
    const broken = await getSession(request(), params({ id: 's1' }));
    expect(broken.status).toBe(503);
    expect(broken.headers.get('cache-control')).toBe('no-store');
    const text = await broken.text();
    expect(text).toBe(JSON.stringify({ error: 'MODEL_AUTH_UNAVAILABLE' }));
  });

  it('reports a missing credential on disconnect', async () => {
    vault.revoke.mockResolvedValueOnce(false);
    const response = await revokeCredential(request('{}'), params({ id: 'c1' }));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'MODEL_CREDENTIAL_NOT_FOUND' });
  });

  it('starts a sign-in with 201', async () => {
    service.start.mockResolvedValueOnce({ id: 's1', status: 'pending' });
    const response = await startSignIn(request('{}'), params({ providerId: 'openai-codex' }));
    expect(response.status).toBe(201);
    expect(service.start).toHaveBeenCalledWith('user:owner-a', 'openai-codex');
  });

  it("returns the provider's open sign-in, or null, for the request owner", async () => {
    service.current.mockResolvedValueOnce({ id: 's1', status: 'awaiting_user' });
    const open = await currentSignIn(request(), params({ providerId: 'openrouter' }));
    expect(open.status).toBe(200);
    expect(open.headers.get('cache-control')).toBe('no-store');
    expect(await open.json()).toEqual({ session: { id: 's1', status: 'awaiting_user' } });
    expect(service.current).toHaveBeenCalledWith('user:owner-a', 'openrouter');

    service.current.mockResolvedValueOnce(null);
    const none = await currentSignIn(request(), params({ providerId: 'openrouter' }));
    expect(await none.json()).toEqual({ session: null });
  });

  it('accepts only a small JSON object as input', async () => {
    service.submitInput.mockResolvedValue({ id: 's1', status: 'awaiting_user' });
    for (const body of ['not json', '[1]', JSON.stringify({ value: 'x'.repeat(9000) })]) {
      const response = await submitInput(request(body), params({ id: 's1' }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'MODEL_AUTH_INPUT_INVALID' });
    }
    const declared = await submitInput(
      request('{"value":"x"}', { 'content-length': '99999' }),
      params({ id: 's1' }),
    );
    expect(declared.status).toBe(400);
    expect(service.submitInput).not.toHaveBeenCalled();

    const ok = await submitInput(
      request(JSON.stringify({ value: 'code-1' })),
      params({ id: 's1' }),
    );
    expect(ok.status).toBe(200);
    expect(service.submitInput).toHaveBeenCalledWith('user:owner-a', 's1', 'code-1');
  });
});
