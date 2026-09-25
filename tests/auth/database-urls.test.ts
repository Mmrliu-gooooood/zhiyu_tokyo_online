import { afterEach, describe, expect, it, vi } from 'vitest';

describe('system database URLs', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('uses DATABASE_URL in legacy even when WORKER_DATABASE_URL is set', async () => {
    vi.resetModules();
    vi.stubEnv('AUTH_MODE', '');
    vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', '');
    vi.stubEnv('DATABASE_URL', 'postgres://legacy');
    vi.stubEnv('WORKER_DATABASE_URL', 'postgres://worker-must-be-ignored');
    const { getSystemDatabaseUrl, getListenDatabaseUrl } = await import('@/lib/db/database-urls');
    expect(getSystemDatabaseUrl()).toBe('postgres://legacy');
    expect(getListenDatabaseUrl()).toBe('postgres://legacy');
  });

  it('requires WORKER_DATABASE_URL when hosted', async () => {
    vi.resetModules();
    vi.stubEnv('AUTH_MODE', 'supabase');
    vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', 'supabase');
    vi.stubEnv('DATABASE_URL', 'postgres://web');
    vi.stubEnv('WORKER_DATABASE_URL', '');
    const { getSystemDatabaseUrl, trySystemDatabaseUrl } = await import('@/lib/db/database-urls');
    expect(() => getSystemDatabaseUrl()).toThrow(/WORKER_DATABASE_URL/);
    expect(trySystemDatabaseUrl()).toBeUndefined();
  });

  it('uses WORKER_DATABASE_URL and optional LISTEN URL when hosted', async () => {
    vi.resetModules();
    vi.stubEnv('AUTH_MODE', 'supabase');
    vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', 'supabase');
    vi.stubEnv('DATABASE_URL', 'postgres://web');
    vi.stubEnv('WORKER_DATABASE_URL', 'postgres://worker');
    vi.stubEnv('DATABASE_LISTEN_URL', 'postgres://listen');
    vi.stubEnv('DATABASE_LISTEN_URL_APP_WEB', 'postgres://web-listen');
    const {
      getSystemDatabaseUrl,
      getListenDatabaseUrl,
      getWebListenDatabaseUrl,
      getAgentRuntimeDatabaseUrl,
      getPersistenceDatabaseUrl,
    } = await import('@/lib/db/database-urls');
    expect(getSystemDatabaseUrl()).toBe('postgres://worker');
    expect(getListenDatabaseUrl()).toBe('postgres://listen');
    expect(getWebListenDatabaseUrl()).toBe('postgres://web-listen');
    expect(getAgentRuntimeDatabaseUrl()).toBe('postgres://worker');
    expect(getPersistenceDatabaseUrl()).toBe('postgres://web');
  });

  it('never falls back from hosted Web LISTEN to a worker credential', async () => {
    vi.stubEnv('AUTH_MODE', 'supabase');
    vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', 'supabase');
    vi.stubEnv('DATABASE_URL', 'postgres://web');
    vi.stubEnv('DATABASE_LISTEN_URL_APP_WEB', '');
    vi.stubEnv('DATABASE_LISTEN_URL', 'postgres://worker-listen');
    const { getWebListenDatabaseUrl } = await import('@/lib/db/database-urls');
    expect(() => getWebListenDatabaseUrl()).toThrow(/DATABASE_LISTEN_URL_APP_WEB/);
  });

  it('keeps Pro agent stores on DATABASE_URL in legacy', async () => {
    vi.resetModules();
    vi.stubEnv('AUTH_MODE', '');
    vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', '');
    vi.stubEnv('DATABASE_URL', 'postgres://legacy');
    vi.stubEnv('WORKER_DATABASE_URL', 'postgres://worker-must-be-ignored');
    const { getAgentRuntimeDatabaseUrl, getPersistenceDatabaseUrl } =
      await import('@/lib/db/database-urls');
    expect(getAgentRuntimeDatabaseUrl()).toBe('postgres://legacy');
    expect(getPersistenceDatabaseUrl()).toBe('postgres://legacy');
  });
});

describe('local asset byte backend', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses local mode without ASSET_LOCAL_ROOT', async () => {
    vi.stubEnv('ASSET_LOCAL_ROOT', '');
    const { resolveLocalAssetRoot } = await import('@/lib/persistence/local-asset-byte-store');
    expect(() => resolveLocalAssetRoot()).toThrow(/ASSET_LOCAL_ROOT/);
  });
});
