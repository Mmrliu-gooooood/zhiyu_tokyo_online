/**
 * Browser client for subscription sign-in and signed-in accounts (plan 3.10).
 * The server never returns a token: accounts carry metadata only, sign-in
 * sessions carry a non-secret challenge (auth link, device code, prompt).
 */

export type SignInStatus =
  | 'pending'
  | 'awaiting_user'
  | 'complete'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'interrupted';

export interface SignInPrompt {
  kind: 'text' | 'secret' | 'select' | 'manual_code';
  message: string;
  placeholder?: string;
  options?: { id: string; label: string; description?: string }[];
}

export interface SignInChallenge {
  authUrl?: string;
  instructions?: string;
  deviceCode?: {
    userCode: string;
    verificationUri: string;
    intervalSeconds?: number;
    expiresInSeconds?: number;
  };
  prompt?: SignInPrompt;
  progress?: string;
  info?: { message: string; links?: { url: string; label?: string }[] };
}

export interface SignInSession {
  id: string;
  providerId: string;
  status: SignInStatus;
  challenge: SignInChallenge | null;
  errorCode: string | null;
  credentialId: string | null;
  expiresAt: string;
}

export interface SignedInAccount {
  id: string;
  providerId: string;
  status: 'active' | 'reauth_required' | 'revoked';
  accountLabel: string | null;
  updatedAt: string;
}

export const OPEN_SIGN_IN_STATUSES: readonly SignInStatus[] = ['pending', 'awaiting_user'];

/** A fixed error code from the API (never an upstream message). */
export class ModelAuthClientError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = 'ModelAuthClientError';
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  });
  if (!response.ok) {
    let code = response.status === 404 ? 'MODEL_AUTH_UNAVAILABLE' : 'MODEL_AUTH_REQUEST_FAILED';
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === 'string' && /^[A-Z_]+$/.test(body.error)) code = body.error;
    } catch {
      // Not JSON: keep the status-derived code.
    }
    throw new ModelAuthClientError(code, response.status);
  }
  return (await response.json()) as T;
}

const segment = encodeURIComponent;

export const modelAuthClient = {
  async listAccounts(signal?: AbortSignal): Promise<SignedInAccount[]> {
    const body = await call<{ credentials: SignedInAccount[] }>('/api/model-credentials', {
      signal,
    });
    return body.credentials;
  },
  async disconnect(credentialId: string): Promise<void> {
    await call(`/api/model-credentials/${segment(credentialId)}`, { method: 'DELETE' });
  },
  async start(providerId: string): Promise<SignInSession> {
    const body = await call<{ session: SignInSession }>(
      `/api/model-auth/${segment(providerId)}/start`,
      { method: 'POST', body: '{}' },
    );
    return body.session;
  },
  async get(sessionId: string, signal?: AbortSignal): Promise<SignInSession> {
    const body = await call<{ session: SignInSession }>(
      `/api/model-auth/sessions/${segment(sessionId)}`,
      { signal },
    );
    return body.session;
  },
  async submit(sessionId: string, value: string): Promise<SignInSession> {
    const body = await call<{ session: SignInSession }>(
      `/api/model-auth/sessions/${segment(sessionId)}/input`,
      { method: 'POST', body: JSON.stringify({ value }) },
    );
    return body.session;
  },
  async cancel(sessionId: string): Promise<SignInSession> {
    const body = await call<{ session: SignInSession }>(
      `/api/model-auth/sessions/${segment(sessionId)}`,
      { method: 'DELETE' },
    );
    return body.session;
  },
};
