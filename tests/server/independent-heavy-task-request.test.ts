import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getGenerationRequestPool: vi.fn(),
}));

vi.mock('@/lib/server/generation-jobs/runtime', () => ({
  backgroundGenerationEnabled: () => false,
  getGenerationRequestPool: mocks.getGenerationRequestPool,
}));

vi.mock('@/lib/server/agent-runtime/owner', () => ({
  resolveRequestOwnerIdAsync: async () => 'owner-a',
}));

import { runIndependentHeavyTaskRequest } from '@/lib/server/heavy-task-admission/independent-request';

function fakePool(
  options: {
    activeOwner?: boolean;
    loseHeartbeat?: boolean;
    heartbeatError?: boolean;
    releaseFailures?: number;
  } = {},
) {
  let released = false;
  const transactionQueries: string[] = [];
  const transactionParameters: unknown[][] = [];
  const poolQueries: string[] = [];
  const poolParameters: unknown[][] = [];
  let remainingReleaseFailures = options.releaseFailures ?? 0;
  const client = {
    async query(sql: string, parameters?: unknown[]) {
      transactionQueries.push(sql);
      transactionParameters.push(parameters ?? []);
      if (sql.includes('SET expires_at')) {
        if (options.heartbeatError) throw new Error('database unavailable');
        return {
          rows: options.loseHeartbeat ? [] : [{ slot_no: 1 }],
          rowCount: options.loseHeartbeat ? 0 : 1,
        };
      }
      if (
        sql.includes('DELETE FROM generation_provider_slots') &&
        sql.includes('holder_attempt_id=$3') &&
        remainingReleaseFailures > 0
      ) {
        remainingReleaseFailures -= 1;
        throw new Error('database unavailable');
      }
      if (sql.includes("to_regclass('generation_jobs')")) {
        return {
          rows: [
            {
              generation_jobs: null,
              agent_sessions: null,
              agent_session_materials: null,
              generation_provider_slots: 'generation_provider_slots',
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes('WITH active_roots')) {
        return {
          rows: [
            {
              active_roots: options.activeOwner ? '1' : '0',
              active_owner_roots: options.activeOwner ? '1' : '0',
              inherited: false,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes('WITH request_params')) {
        return {
          rows: [{ candidate_present: true, oldest_root: parameters?.[1] }],
          rowCount: 1,
        };
      }
      if (sql.includes('INSERT INTO generation_provider_slots')) {
        return { rows: [], rowCount: 2 };
      }
      if (sql.includes('WITH available AS')) {
        return { rows: [{ slot_no: 1, lease_epoch: 1 }], rowCount: 1 };
      }
      if (sql.includes('app_internal.acquire_heavy_task_sync_lease')) {
        return { rows: [{ slot_no: 1, lease_epoch: 1 }], rowCount: 1 };
      }
      if (sql.includes('app_internal.heavy_task_capacity')) {
        return {
          rows: [
            {
              total_count: '0',
              owner_count: '0',
              inherited: false,
              candidate_present: true,
              oldest_root: parameters?.[2],
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [{}], rowCount: 1 };
    },
    release() {
      released = true;
    },
  };
  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn(async (sql: string, parameters?: unknown[]) => {
      poolQueries.push(sql);
      poolParameters.push(parameters ?? []);
      if (sql.includes('SET expires_at')) {
        if (options.heartbeatError) throw new Error('database unavailable');
        return { rows: [], rowCount: options.loseHeartbeat ? 0 : 1 };
      }
      if (sql.includes('DELETE FROM') && remainingReleaseFailures > 0) {
        remainingReleaseFailures -= 1;
        throw new Error('database unavailable');
      }
      return { rows: [], rowCount: 1 };
    }),
  };
  return {
    pool,
    poolQueries,
    poolParameters,
    transactionQueries,
    transactionParameters,
    wasReleased: () => released,
  };
}

describe('independent heavy-task request admission', () => {
  beforeEach(() => {
    vi.stubEnv('DATABASE_URL', 'postgres://test');
    mocks.getGenerationRequestPool.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('commits and releases the SQL client before provider work, then deletes the fenced lease', async () => {
    const state = fakePool();
    mocks.getGenerationRequestPool.mockReturnValue(state.pool);

    const response = await runIndependentHeavyTaskRequest(
      new Request('http://localhost/api/parse-pdf', { method: 'POST' }),
      'document-extraction',
      async () => {
        expect(state.wasReleased()).toBe(true);
        return Response.json({ success: true });
      },
    );

    expect(response.status).toBe(200);
    expect(state.transactionQueries.some((sql) => sql.includes('INSERT INTO'))).toBe(true);
    expect(
      state.transactionQueries.some((sql) => sql.includes('expires_at <= clock_timestamp()')),
    ).toBe(true);
    expect(state.transactionQueries.some((sql) => sql.includes('DELETE FROM'))).toBe(true);
    const releaseIndex = state.transactionQueries.findIndex(
      (sql) =>
        sql.includes('DELETE FROM generation_provider_slots') &&
        sql.includes('holder_attempt_id=$3'),
    );
    expect(state.transactionParameters[releaseIndex]).toEqual([
      'heavy-task:sync-owner:owner-a',
      1,
      expect.any(String),
      1,
    ]);
    expect(state.wasReleased()).toBe(true);
  });

  it('aborts provider work on lease loss and waits for it to settle before returning', async () => {
    vi.useFakeTimers();
    const state = fakePool({ loseHeartbeat: true });
    mocks.getGenerationRequestPool.mockReturnValue(state.pool);
    let bodySettled = false;

    const pending = runIndependentHeavyTaskRequest(
      new Request('http://localhost/api/parse-pdf', { method: 'POST' }),
      'document-extraction',
      (signal) =>
        new Promise<Response>((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              setTimeout(() => {
                bodySettled = true;
                resolve(Response.json({ success: false }));
              }, 100);
            },
            { once: true },
          );
        }),
    );

    await vi.advanceTimersByTimeAsync(30_000);
    expect(bodySettled).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    const response = await pending;

    expect(bodySettled).toBe(true);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      errorCode: 'HEAVY_TASK_ADMISSION_UNAVAILABLE',
    });
    expect(state.transactionQueries.some((sql) => sql.includes('DELETE FROM'))).toBe(true);
  });

  it('preserves the real provider result when a heartbeat query is only unavailable', async () => {
    vi.useFakeTimers();
    const state = fakePool({ heartbeatError: true });
    mocks.getGenerationRequestPool.mockReturnValue(state.pool);
    let resolveBody: ((response: Response) => void) | undefined;
    let receivedSignal: AbortSignal | undefined;

    const pending = runIndependentHeavyTaskRequest(
      new Request('http://localhost/api/generate/image', { method: 'POST' }),
      'media',
      (signal) => {
        receivedSignal = signal;
        return new Promise<Response>((resolve) => {
          resolveBody = resolve;
        });
      },
    );

    await vi.advanceTimersByTimeAsync(30_000);
    expect(receivedSignal?.aborted).toBe(false);
    resolveBody?.(Response.json({ success: true }));
    const response = await pending;

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true });
  });

  it('aborts before an unconfirmed lease can expire without replacing the real response', async () => {
    vi.useFakeTimers();
    const state = fakePool({ heartbeatError: true });
    mocks.getGenerationRequestPool.mockReturnValue(state.pool);

    const pending = runIndependentHeavyTaskRequest(
      new Request('http://localhost/api/generate/image', { method: 'POST' }),
      'media',
      (signal) =>
        new Promise<Response>((resolve) => {
          signal.addEventListener(
            'abort',
            () => resolve(Response.json({ providerStatus: 'unknown' }, { status: 500 })),
            { once: true },
          );
        }),
    );

    await vi.advanceTimersByTimeAsync(45 * 60 * 1000);
    const response = await pending;

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ providerStatus: 'unknown' });
  });

  it('retries a transient fenced-release failure without delaying the response', async () => {
    vi.useFakeTimers();
    const state = fakePool({ releaseFailures: 1 });
    mocks.getGenerationRequestPool.mockReturnValue(state.pool);

    const response = await runIndependentHeavyTaskRequest(
      new Request('http://localhost/api/generate/image', { method: 'POST' }),
      'media',
      async () => Response.json({ success: true }),
    );
    expect(response.status).toBe(200);
    expect(
      state.transactionQueries.filter(
        (sql) =>
          sql.includes('DELETE FROM generation_provider_slots') &&
          sql.includes('holder_attempt_id=$3'),
      ),
    ).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(
      state.transactionQueries.filter(
        (sql) =>
          sql.includes('DELETE FROM generation_provider_slots') &&
          sql.includes('holder_attempt_id=$3'),
      ),
    ).toHaveLength(2);
  });

  it('returns the stable personal-capacity protocol before running provider work', async () => {
    const state = fakePool({ activeOwner: true });
    mocks.getGenerationRequestPool.mockReturnValue(state.pool);
    const body = vi.fn(async () => Response.json({ success: true }));

    const response = await runIndependentHeavyTaskRequest(
      new Request('http://localhost/api/parse-pdf', { method: 'POST' }),
      'document-extraction',
      body,
    );

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      errorCode: 'HEAVY_TASK_PERSONAL_CAPACITY_LIMIT',
    });
    expect(body).not.toHaveBeenCalled();
  });

  it('uses only fenced aggregate and sync-lease functions in hosted Web mode', async () => {
    vi.stubEnv('AUTH_MODE', 'supabase');
    vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', 'supabase');
    const state = fakePool();
    mocks.getGenerationRequestPool.mockReturnValue(state.pool);

    const response = await runIndependentHeavyTaskRequest(
      new Request('http://localhost/api/generate/image', { method: 'POST' }),
      'media',
      async () => Response.json({ success: true }),
    );

    expect(response.status).toBe(200);
    expect(
      state.transactionQueries.some((sql) => sql.includes('app_internal.heavy_task_capacity')),
    ).toBe(true);
    expect(
      state.transactionQueries.some((sql) =>
        sql.includes('app_internal.acquire_heavy_task_sync_lease'),
      ),
    ).toBe(true);
    expect(
      state.transactionQueries.some((sql) =>
        sql.includes('app_internal.release_heavy_task_sync_lease'),
      ),
    ).toBe(true);
    expect(
      state.transactionQueries.some((sql) => sql.includes('INSERT INTO generation_provider_slots')),
    ).toBe(false);
  });

  it('does not allocate a random media root when the request names its foreground course root', async () => {
    const state = fakePool();
    mocks.getGenerationRequestPool.mockReturnValue(state.pool);
    const response = await runIndependentHeavyTaskRequest(
      new Request('http://localhost/api/generate/image', {
        method: 'POST',
        headers: { 'x-generation-root-stage-id': 'stage-1' },
      }),
      'media',
      async () => Response.json({ success: true }),
    );

    expect(response.status).toBe(200);
    expect(
      state.transactionQueries.some((sql) => sql.includes('acquire_heavy_task_sync_lease')),
    ).toBe(false);
    expect(
      state.transactionQueries.some((sql) => sql.includes('INSERT INTO generation_provider_slots')),
    ).toBe(false);
  });
});
