import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  closeRegisteredPoolsForTests,
  getGenerationRequestPool,
  getPersistencePool,
  getSystemPool,
} from '@/lib/db/pool-registry';

describe('database pool registry', () => {
  afterEach(async () => {
    await closeRegisteredPoolsForTests();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('reuses one pool per database role and URL', () => {
    vi.stubEnv('AUTH_MODE', 'supabase');
    vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', 'supabase');
    vi.stubEnv('DATABASE_URL', 'postgresql://app-web@db.example.test/postgres');
    vi.stubEnv('WORKER_DATABASE_URL', 'postgresql://app-worker@db.example.test/postgres');

    const web = getPersistencePool();
    const request = getGenerationRequestPool();
    const sameWeb = getPersistencePool();
    const worker = getSystemPool();
    const sameWorker = getSystemPool();

    expect(sameWeb).toBe(web);
    expect(request).toBe(web);
    expect(sameWorker).toBe(worker);
    expect(worker).not.toBe(web);
    expect(web.options.max).toBe(5);
    expect(worker.options.max).toBe(3);
    for (const pool of [web, worker]) {
      expect(pool.options.idleTimeoutMillis).toBe(60_000);
      expect(pool.options.connectionTimeoutMillis).toBe(10_000);
    }
  });

  it('shares the legacy database pool when both roles use DATABASE_URL', () => {
    vi.stubEnv('AUTH_MODE', '');
    vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', '');
    vi.stubEnv('DATABASE_URL', 'postgresql://legacy@db.example.test/openmaic');

    expect(getPersistencePool()).toBe(getSystemPool());
    expect(getSystemPool().options.max).toBe(8);
    expect(getSystemPool().options.idleTimeoutMillis).toBe(10_000);
  });

  it('keeps the hosted Web request pool usable without WORKER_DATABASE_URL', () => {
    vi.stubEnv('AUTH_MODE', 'supabase');
    vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', 'supabase');
    vi.stubEnv('DATABASE_URL', 'postgresql://app-web@db.example.test/postgres');
    vi.stubEnv('WORKER_DATABASE_URL', '');

    expect(getGenerationRequestPool()).toBe(getPersistencePool());
    expect(() => getSystemPool()).toThrow(/WORKER_DATABASE_URL/);
  });
});
