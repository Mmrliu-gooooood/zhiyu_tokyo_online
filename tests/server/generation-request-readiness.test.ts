import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('@/lib/db/pool-registry', () => ({
  getGenerationRequestPool: () => ({ query: mocks.query }),
  getSystemPool: () => {
    throw new Error('Web must not open the system pool');
  },
}));

import { generationRequestReadiness } from '@/lib/server/generation-jobs/runtime';

describe('hosted request readiness', () => {
  afterEach(() => {
    mocks.query.mockReset();
    vi.unstubAllEnvs();
  });

  it('reads the sanitized SECURITY DEFINER projection through app_web', async () => {
    vi.stubEnv('AUTH_MODE', 'supabase');
    vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', 'supabase');
    vi.stubEnv('GENERATION_BACKGROUND_ENABLED', '1');
    vi.stubEnv('GENERATION_ACCEPTING_JOBS', '1');
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql === 'SELECT 1') return { rows: [{}], rowCount: 1 };
      expect(sql).toBe('SELECT * FROM app_internal.generation_readiness()');
      return { rows: [{ schema_version: 4, worker_live: true }], rowCount: 1 };
    });

    await expect(generationRequestReadiness()).resolves.toMatchObject({
      database: true,
      schema: true,
      worker: true,
      accepting: true,
    });
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });
});
