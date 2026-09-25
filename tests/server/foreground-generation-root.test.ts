import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  client: {
    query: vi.fn(),
    release: vi.fn(),
  },
}));

vi.mock('@/lib/server/generation-jobs/runtime', () => ({
  getGenerationRequestPool: () => ({ connect: async () => mocks.client }),
}));

vi.mock('@/lib/db/request-queryable', () => ({
  createOwnerBoundTransactionSource: () => ({ connect: async () => mocks.client }),
  createOwnerBoundQueryable: () => mocks.client,
}));

import {
  acquireForegroundGenerationRoot,
  foregroundGenerationRootId,
  releaseForegroundGenerationRoot,
} from '@/lib/server/heavy-task-admission/foreground-generation';

describe('foreground course root lease', () => {
  beforeEach(() => {
    vi.stubEnv('AUTH_MODE', 'supabase');
    vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', 'supabase');
    vi.stubEnv('APP_HEAVY_TASK_LIMIT', '16');
    vi.stubEnv('APP_HEAVY_TASK_PER_OWNER_LIMIT', '2');
    mocks.client.query.mockReset();
    mocks.client.release.mockReset();
    mocks.client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('acquire_foreground_generation_root')) {
        return { rows: [{ allowed: true, reason: null }] };
      }
      if (sql.includes('release_heavy_task_foreground_lease')) {
        return { rows: [{ released: true }] };
      }
      return { rows: [] };
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  it('derives a stable owner+stage root and uses only the hosted definer seams', async () => {
    const owner = 'user:11111111-1111-4111-8111-111111111111';
    const firstRoot = foregroundGenerationRootId(owner, 'stage-a', 'session-1');
    expect(foregroundGenerationRootId(owner, 'stage-a', 'session-1')).toBe(firstRoot);
    expect(foregroundGenerationRootId(owner, 'stage-a', 'session-2')).not.toBe(firstRoot);
    expect(foregroundGenerationRootId(owner, 'stage-b', 'session-1')).not.toBe(firstRoot);
    expect(foregroundGenerationRootId(`${owner}-other`, 'stage-a', 'session-1')).not.toBe(
      firstRoot,
    );

    await expect(acquireForegroundGenerationRoot(owner, 'stage-a', 'session-1')).resolves.toEqual({
      allowed: true,
    });
    await expect(acquireForegroundGenerationRoot(owner, 'stage-a', 'session-1')).resolves.toEqual({
      allowed: true,
    });
    await releaseForegroundGenerationRoot(owner, 'stage-a', 'session-1');

    const acquireCalls = mocks.client.query.mock.calls.filter(([sql]) =>
      String(sql).includes('acquire_foreground_generation_root'),
    );
    expect(acquireCalls).toHaveLength(2);
    expect(acquireCalls[0]?.[1]?.[1]).toBe(acquireCalls[1]?.[1]?.[1]);
    const releaseCall = mocks.client.query.mock.calls.find(([sql]) =>
      String(sql).includes('release_heavy_task_foreground_lease'),
    );
    expect(releaseCall?.[1]?.[1]).toBe(acquireCalls[0]?.[1]?.[1]);
    expect(
      mocks.client.query.mock.calls.some(([sql]) =>
        /(?:INSERT|UPDATE|DELETE)\s+(?:FROM\s+)?generation_provider_slots/i.test(String(sql)),
      ),
    ).toBe(false);
  });

  it('maps hosted personal and site refusals onto the stable admission protocol', async () => {
    mocks.client.query.mockImplementationOnce(async () => ({ rows: [] })); // BEGIN
    mocks.client.query.mockImplementationOnce(async () => ({
      rows: [{ allowed: false, reason: 'personal_limit' }],
    }));
    mocks.client.query.mockImplementationOnce(async () => ({ rows: [] })); // COMMIT
    await expect(
      acquireForegroundGenerationRoot('owner-a', 'stage-a', 'session-1'),
    ).resolves.toEqual({
      allowed: false,
      reason: 'personal_limit',
    });
  });

  it('maps the v13 deletion fence without admitting a provider request', async () => {
    mocks.client.query.mockImplementationOnce(async () => ({ rows: [] })); // BEGIN
    mocks.client.query.mockImplementationOnce(async () => ({
      rows: [{ allowed: false, reason: 'account_inactive' }],
    }));
    mocks.client.query.mockImplementationOnce(async () => ({ rows: [] })); // COMMIT
    await expect(
      acquireForegroundGenerationRoot('owner-a', 'stage-a', 'session-1'),
    ).resolves.toEqual({ allowed: false, reason: 'account_inactive' });
  });
});
