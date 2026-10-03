// @vitest-environment jsdom
/**
 * P6-5: the settings sign-in panel — connection state, device-code and
 * manual-code sign-in, disconnect, and polling that stops on account switch.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string, vars?: Record<string, string>) =>
      vars ? `${key}(${Object.values(vars).join(',')})` : key,
  }),
}));

const hydration = vi.hoisted(() => ({
  onHydrate: [] as Array<() => void>,
  onFinish: [] as Array<() => void>,
}));
vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: {
    persist: {
      onHydrate: (fn: () => void) => {
        hydration.onHydrate.push(fn);
        return () => undefined;
      },
      onFinishHydration: (fn: () => void) => {
        hydration.onFinish.push(fn);
        return () => undefined;
      },
    },
  },
}));

import { SubscriptionSignIn } from '@/components/settings/subscription-sign-in';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Route = (init: RequestInit | undefined) => { status?: number; body: unknown };
let routes: Record<string, Route>;
let requests: Array<{ method: string; path: string; body?: string }>;
let container: HTMLDivElement;
let root: Root;
const onCredentialChange = vi.fn();

const PROVIDER = 'openai-codex';
const SESSION = '22222222-2222-4222-8222-222222222222';
const CREDENTIAL = '33333333-3333-4333-8333-333333333333';
const expiresAt = () => new Date(Date.now() + 600_000).toISOString();

function session(status: string, challenge: unknown = null, extra: Record<string, unknown> = {}) {
  return {
    session: {
      id: SESSION,
      providerId: PROVIDER,
      status,
      challenge,
      errorCode: null,
      credentialId: null,
      expiresAt: expiresAt(),
      ...extra,
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  requests = [];
  routes = { 'GET /api/model-credentials': () => ({ body: { credentials: [] } }) };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      requests.push({ method, path: input, body: init?.body as string | undefined });
      const route = routes[`${method} ${input}`];
      if (!route) return new Response('{}', { status: 500 });
      const { status = 200, body } = route(init);
      return new Response(JSON.stringify(body), { status });
    }),
  );
  hydration.onHydrate.length = 0;
  hydration.onFinish.length = 0;
  onCredentialChange.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function mount(props: Record<string, unknown> = {}) {
  await act(async () => {
    root.render(
      createElement(SubscriptionSignIn, {
        providerId: PROVIDER,
        onCredentialChange,
        ...props,
      }),
    );
  });
  await flush();
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((item) =>
    item.textContent?.includes(label),
  );
  if (!found) throw new Error(`no button ${label}: ${container.textContent}`);
  return found as HTMLButtonElement;
}

async function click(label: string) {
  await act(async () => {
    button(label).click();
  });
  await flush();
}

describe('subscription sign-in panel', () => {
  it('completes a device-code sign-in and saves only the credential id', async () => {
    await mount();
    expect(container.textContent).toContain('settings.oauthStatusNotConnected');

    routes[`POST /api/model-auth/${PROVIDER}/start`] = () => ({ status: 201, body: session('pending') });
    routes[`GET /api/model-auth/sessions/${SESSION}`] = () => ({
      body: session('awaiting_user', {
        deviceCode: {
          userCode: 'ABCD-1234',
          verificationUri: 'https://auth.example.test/device',
          expiresInSeconds: 600,
        },
      }),
    });
    await click('settings.oauthSignIn');
    await flush(1600);
    expect(container.querySelector('[data-testid="device-code"]')?.textContent).toBe('ABCD-1234');
    const link = container.querySelector('a[href="https://auth.example.test/device"]');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(container.textContent).toContain('settings.oauthExpiresIn');

    routes[`GET /api/model-auth/sessions/${SESSION}`] = () => ({
      body: session('complete', null, { credentialId: CREDENTIAL }),
    });
    routes['GET /api/model-credentials'] = () => ({
      body: {
        credentials: [
          {
            id: CREDENTIAL,
            providerId: PROVIDER,
            status: 'active',
            accountLabel: 'u***@example.com',
            updatedAt: new Date().toISOString(),
          },
        ],
      },
    });
    await flush(1600);
    expect(onCredentialChange).toHaveBeenCalledWith({
      authMode: 'oauth',
      credentialId: CREDENTIAL,
      credentialStatus: 'active',
    });
    expect(container.textContent).toContain('settings.oauthStatusConnected');
    expect(container.textContent).toContain('u***@example.com');
    // Polling stopped once the sign-in ended.
    const polls = requests.filter((item) => item.path.includes('/sessions/')).length;
    await flush(5000);
    expect(requests.filter((item) => item.path.includes('/sessions/')).length).toBe(polls);
  });

  it('submits a pasted redirect for a manual-code prompt and can cancel', async () => {
    await mount();
    routes[`POST /api/model-auth/${PROVIDER}/start`] = () => ({
      status: 201,
      body: session('awaiting_user', {
        authUrl: 'https://auth.example.test/authorize',
        prompt: { kind: 'manual_code', message: 'Paste the redirect URL' },
      }),
    });
    routes[`GET /api/model-auth/sessions/${SESSION}`] = () => ({
      body: session('awaiting_user', {
        authUrl: 'https://auth.example.test/authorize',
        prompt: { kind: 'manual_code', message: 'Paste the redirect URL' },
      }),
    });
    await click('settings.oauthSignIn');
    expect(container.querySelector('a[href="https://auth.example.test/authorize"]')).not.toBeNull();
    const input = container.querySelector('input') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'http://localhost:1455/auth/callback?code=abc');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    routes[`POST /api/model-auth/sessions/${SESSION}/input`] = () => ({ body: session('pending') });
    await click('settings.oauthSubmit');
    const submitted = requests.find((item) => item.path.endsWith('/input'));
    expect(JSON.parse(submitted!.body!)).toEqual({
      value: 'http://localhost:1455/auth/callback?code=abc',
    });

    routes[`DELETE /api/model-auth/sessions/${SESSION}`] = () => ({ body: session('cancelled') });
    await click('settings.oauthCancel');
    expect(container.textContent).toContain('settings.oauthCancelled');
    expect(container.textContent).toContain('settings.oauthSignIn');
  });

  it('disconnects a signed-in account', async () => {
    routes['GET /api/model-credentials'] = () => ({
      body: {
        credentials: [
          { id: CREDENTIAL, providerId: PROVIDER, status: 'active', accountLabel: null, updatedAt: '' },
        ],
      },
    });
    await mount({ credentialId: CREDENTIAL, credentialStatus: 'active', authMode: 'oauth' });
    expect(container.textContent).toContain('settings.oauthStatusConnected');
    routes[`DELETE /api/model-credentials/${CREDENTIAL}`] = () => ({ body: { revoked: true } });
    await click('settings.oauthDisconnect');
    expect(onCredentialChange).toHaveBeenLastCalledWith({
      authMode: 'api-key',
      credentialId: undefined,
      credentialStatus: 'revoked',
    });
    expect(container.textContent).toContain('settings.oauthStatusNotConnected');
  });

  it('follows the server: a reauth-required account and an unavailable deployment', async () => {
    routes['GET /api/model-credentials'] = () => ({
      body: {
        credentials: [
          {
            id: CREDENTIAL,
            providerId: PROVIDER,
            status: 'reauth_required',
            accountLabel: null,
            updatedAt: '',
          },
        ],
      },
    });
    await mount({ credentialId: CREDENTIAL, credentialStatus: 'active' });
    expect(container.textContent).toContain('settings.oauthStatusReauth');
    expect(button('settings.oauthSignInAgain')).toBeTruthy();
    expect(onCredentialChange).toHaveBeenCalledWith({
      authMode: 'oauth',
      credentialId: CREDENTIAL,
      credentialStatus: 'reauth_required',
    });

    act(() => root.unmount());
    root = createRoot(container);
    routes['GET /api/model-credentials'] = () => ({ status: 404, body: {} });
    await mount();
    expect(container.textContent).toContain('settings.oauthSignInPending');
  });

  it('stops polling when the account switches', async () => {
    await mount();
    routes[`POST /api/model-auth/${PROVIDER}/start`] = () => ({ status: 201, body: session('pending') });
    routes[`GET /api/model-auth/sessions/${SESSION}`] = () => ({ body: session('pending') });
    await click('settings.oauthSignIn');
    await flush(1600);
    const before = requests.filter((item) => item.path.includes('/sessions/')).length;
    expect(before).toBeGreaterThan(0);
    await act(async () => {
      for (const fn of hydration.onHydrate) fn();
    });
    await flush(6000);
    expect(requests.filter((item) => item.path.includes('/sessions/')).length).toBe(before);
    expect(container.textContent).toContain('settings.oauthLoading');
  });
});
