import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getGenerationPool: vi.fn(),
}));

vi.mock('@/lib/server/generation-jobs/runtime', () => ({
  backgroundGenerationEnabled: () => false,
  getGenerationPool: mocks.getGenerationPool,
}));

vi.mock('@/lib/server/agent-runtime/owner', () => ({
  resolveRequestOwnerId: () => 'owner-a',
}));

import { runIndependentHeavyTaskRequest } from '@/lib/server/heavy-task-admission/independent-request';

function fakePool(options: { activeOwner?: boolean; loseHeartbeat?: boolean } = {}) {
  let released = false;
  const transactionQueries: string[] = [];
  const poolQueries: string[] = [];
  const client = {
    async query(sql: string, parameters?: unknown[]) {
      transactionQueries.push(sql);
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
        return { rows: [{ lease_epoch: 1 }], rowCount: 1 };
      }
      return { rows: [{}], rowCount: 1 };
    },
    release() {
      released = true;
    },
  };
  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn(async (sql: string) => {
      poolQueries.push(sql);
      if (sql.includes('SET expires_at')) {
        return { rows: [], rowCount: options.loseHeartbeat ? 0 : 1 };
      }
      return { rows: [], rowCount: 1 };
    }),
  };
  return { pool, poolQueries, transactionQueries, wasReleased: () => released };
}

describe('independent heavy-task request admission', () => {
  beforeEach(() => {
    vi.stubEnv('DATABASE_URL', 'postgres://test');
    mocks.getGenerationPool.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('commits and releases the SQL client before provider work, then deletes the fenced lease', async () => {
    const state = fakePool();
    mocks.getGenerationPool.mockReturnValue(state.pool);

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
    expect(state.poolQueries.some((sql) => sql.includes('DELETE FROM'))).toBe(true);
  });

  it('fails closed when a heartbeat proves the fenced lease was lost', async () => {
    vi.useFakeTimers();
    const state = fakePool({ loseHeartbeat: true });
    mocks.getGenerationPool.mockReturnValue(state.pool);

    const pending = runIndependentHeavyTaskRequest(
      new Request('http://localhost/api/parse-pdf', { method: 'POST' }),
      'document-extraction',
      () => new Promise<Response>(() => undefined),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    const response = await pending;

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      errorCode: 'HEAVY_TASK_ADMISSION_UNAVAILABLE',
    });
  });

  it('returns the stable personal-capacity protocol before running provider work', async () => {
    const state = fakePool({ activeOwner: true });
    mocks.getGenerationPool.mockReturnValue(state.pool);
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
});
