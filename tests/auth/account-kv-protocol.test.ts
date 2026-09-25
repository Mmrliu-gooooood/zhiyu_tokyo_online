import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = 'user:09ee0532-7110-4bd4-ae73-e95f4d5126b0';

const state = vi.hoisted(() => ({
  rows: new Map<string, unknown>(),
  ownerId: undefined as string | undefined,
}));

vi.mock('@/lib/auth/session', () => ({
  requirePrincipal: async () => ({
    userId: OWNER.slice('user:'.length),
    ownerId: OWNER,
    learnerKey: OWNER,
    assetPrincipal: OWNER,
    role: 'user' as const,
    sessionId: '22222222-2222-4222-8222-222222222222',
    email: 'kv@example.com',
    status: 'active' as const,
  }),
}));

vi.mock('@/lib/db/pool-registry', () => ({
  getPersistencePool: () => ({}),
}));

vi.mock('@/lib/db/request-queryable', () => ({
  createOwnerBoundQueryable: (_pool: unknown, ownerId: string) => {
    state.ownerId = ownerId;
    return {
      query: async (sql: string, params: unknown[] = []) => {
        if (/SELECT value FROM account_kv/.test(sql)) {
          const key = String(params[1]);
          return { rows: state.rows.has(key) ? [{ value: state.rows.get(key) }] : [] };
        }
        if (/SELECT key FROM account_kv/.test(sql)) {
          return {
            rows: [...state.rows.keys()]
              .filter((key) => (params[1] as string[]).includes(key))
              .sort()
              .map((key) => ({ key })),
          };
        }
        if (/INSERT INTO account_kv/.test(sql)) {
          state.rows.set(String(params[1]), JSON.parse(String(params[2])) as unknown);
        }
        if (/DELETE FROM account_kv/.test(sql)) {
          state.rows.delete(String(params[1]));
        }
        return { rows: [] };
      },
    };
  },
}));

describe('safe account KV HTTP protocol', () => {
  beforeEach(() => {
    vi.resetModules();
    state.rows.clear();
    state.ownerId = undefined;
    vi.stubEnv('AUTH_MODE', 'supabase');
    vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', 'supabase');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://lzomhnjyymalupgvcato.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
    vi.stubEnv('DATABASE_URL', 'postgresql://app-web@example.test/postgres');
    vi.stubEnv('APP_ORIGIN', 'http://localhost:3000');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads an allowlisted entry through the authenticated owner', async () => {
    state.rows.set('settings.ui', { playbackSpeed: 1.25 });
    const { GET } = await import('@/app/api/kv/[...path]/route');

    const response = await GET(new Request('http://localhost:3000/api/kv/entries/settings.ui'), {
      params: Promise.resolve({ path: ['entries', 'settings.ui'] }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ value: { playbackSpeed: 1.25 } });
    expect(state.ownerId).toBe(OWNER);
  });

  it('writes an allowlisted entry using the HttpAccountKV value envelope', async () => {
    const { PUT } = await import('@/app/api/kv/[...path]/route');

    const response = await PUT(
      new Request('http://localhost:3000/api/kv/entries/settings.locale', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
        body: JSON.stringify({ value: 'zh-CN' }),
      }),
      { params: Promise.resolve({ path: ['entries', 'settings.locale'] }) },
    );

    expect(response.status).toBe(204);
    expect(state.rows.get('settings.locale')).toBe('zh-CN');
    expect(state.ownerId).toBe(OWNER);
  });

  it('deletes an allowlisted entry idempotently', async () => {
    state.rows.set('workspace.tabs', ['course-a']);
    const { DELETE } = await import('@/app/api/kv/[...path]/route');

    const response = await DELETE(
      new Request('http://localhost:3000/api/kv/entries/workspace.tabs', {
        method: 'DELETE',
        headers: { origin: 'http://localhost:3000' },
      }),
      { params: Promise.resolve({ path: ['entries', 'workspace.tabs'] }) },
    );

    expect(response.status).toBe(204);
    expect(state.rows.has('workspace.tabs')).toBe(false);
  });

  it('lists only allowlisted account keys under the requested prefix', async () => {
    state.rows.set('settings.locale', 'zh-CN');
    state.rows.set('settings.ui', { theme: 'dark' });
    state.rows.set('workspace.tabs', ['course-a']);
    state.rows.set('settings-storage', { apiKey: 'must-not-leak' });
    const { GET } = await import('@/app/api/kv/[...path]/route');

    const response = await GET(new Request('http://localhost:3000/api/kv/keys?prefix=settings.'), {
      params: Promise.resolve({ path: ['keys'] }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(['settings.locale', 'settings.ui']);
    expect(state.ownerId).toBe(OWNER);
  });

  it('rejects the full settings store so provider credentials cannot be uploaded', async () => {
    const { PUT } = await import('@/app/api/kv/[...path]/route');

    const response = await PUT(
      new Request('http://localhost:3000/api/kv/entries/settings-storage', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
        body: JSON.stringify({ value: { apiKey: 'must-not-upload' } }),
      }),
      { params: Promise.resolve({ path: ['entries', 'settings-storage'] }) },
    );

    expect(response.status).toBe(400);
    expect(state.rows.has('settings-storage')).toBe(false);
  });

  it('rejects a scope field because this transport is account-only', async () => {
    const { PUT } = await import('@/app/api/kv/[...path]/route');

    const response = await PUT(
      new Request('http://localhost:3000/api/kv/entries/settings.ui', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
        body: JSON.stringify({ value: { theme: 'dark' }, scope: 'device' }),
      }),
      { params: Promise.resolve({ path: ['entries', 'settings.ui'] }) },
    );

    expect(response.status).toBe(400);
    expect(state.rows.has('settings.ui')).toBe(false);
  });

  it('preserves the legacy query/body API response contract', async () => {
    const { GET, PUT } = await import('@/app/api/kv/route');

    const missing = await GET(new Request('http://localhost:3000/api/kv?key=profile.displayName'));
    expect(missing.status).toBe(200);
    await expect(missing.json()).resolves.toEqual({ key: 'profile.displayName', value: null });

    const written = await PUT(
      new Request('http://localhost:3000/api/kv', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
        body: JSON.stringify({ key: 'profile.displayName', value: '智宇' }),
      }),
    );
    expect(written.status).toBe(200);
    await expect(written.json()).resolves.toEqual({ success: true });
    expect(state.rows.get('profile.displayName')).toBe('智宇');
  });
});
