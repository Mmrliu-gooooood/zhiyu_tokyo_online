import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  checkHeavyTaskAdmission,
  checkHeavyTaskAttentionCapacity,
  checkHeavyTaskQueueCapacity,
  getHeavyTaskRootContext,
  heavyTaskCapacityConfig,
  heavyTaskOwnerLimit,
  heavyTaskSiteLimit,
  isHeavyTaskFairTurn,
  reserveHeavyTaskAttention,
  withHeavyTaskRootContext,
  type HeavyTaskAdmissionQueryable,
} from '@/lib/server/heavy-task-admission';

function queryable(input: {
  activeRoots: number;
  activeOwnerRoots: number;
  inherited?: boolean;
  relations?: Partial<
    Record<
      | 'generation_jobs'
      | 'agent_sessions'
      | 'agent_session_materials'
      | 'generation_provider_slots',
      string
    >
  >;
}) {
  const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [{}] };
    if (sql.includes("to_regclass('generation_jobs')")) {
      return {
        rows: [
          {
            generation_jobs: input.relations?.generation_jobs ?? 'generation_jobs',
            agent_sessions: input.relations?.agent_sessions ?? 'agent_sessions',
            agent_session_materials:
              input.relations?.agent_session_materials ?? 'agent_session_materials',
            generation_provider_slots: input.relations?.generation_provider_slots ?? null,
          },
        ],
      };
    }
    expect(parameters).toEqual(['owner-a', 'agent:root-a', 90_000, 80_000]);
    return {
      rows: [
        {
          active_roots: String(input.activeRoots),
          active_owner_roots: String(input.activeOwnerRoots),
          inherited: input.inherited ?? false,
        },
      ],
    };
  });
  return { queryable: { query } as unknown as HeavyTaskAdmissionQueryable, query };
}

const request = {
  ownerId: 'owner-a',
  rootTaskId: 'agent:root-a',
  kind: 'agent' as const,
  nowMs: 100_000,
  agentLeaseTtlMs: 10_000,
  materialLeaseTtlMs: 20_000,
};

describe('heavy task admission', () => {
  it('lets read-only status projections avoid contending on the claim lock', async () => {
    const fake = queryable({ activeRoots: 0, activeOwnerRoots: 0 });
    await checkHeavyTaskAdmission(fake.queryable, { ...request, lock: false });
    expect(
      fake.query.mock.calls.some(([sql]) => String(sql).includes('pg_advisory_xact_lock')),
    ).toBe(false);
  });

  it('defaults compatibly and validates the unified 16/2 capacity envelope', () => {
    expect(heavyTaskSiteLimit({})).toBe(1);
    expect(heavyTaskOwnerLimit({})).toBe(1);
    expect(
      heavyTaskCapacityConfig({
        APP_HEAVY_TASK_LIMIT: ' 16 ',
        APP_HEAVY_TASK_PER_OWNER_LIMIT: ' 2 ',
        GENERATION_MAX_QUEUED_JOBS: '100',
        GENERATION_MAX_REVIEW_ATTENTION_JOBS: '100',
      }),
    ).toMatchObject({
      siteLimit: 16,
      ownerLimit: 2,
      queue: { ownerLimit: 5, siteLimit: 100 },
      attention: { ownerLimit: 5, siteLimit: 100 },
    });
    expect(() => heavyTaskSiteLimit({ APP_HEAVY_TASK_LIMIT: '33' })).toThrow(
      'APP_HEAVY_TASK_LIMIT must be an integer from 1 to 32',
    );
    expect(() =>
      heavyTaskCapacityConfig({
        APP_HEAVY_TASK_LIMIT: '1',
        APP_HEAVY_TASK_PER_OWNER_LIMIT: '2',
      }),
    ).toThrow('APP_HEAVY_TASK_PER_OWNER_LIMIT must not exceed APP_HEAVY_TASK_LIMIT');
  });

  it('serializes the decision before counting all durable live root kinds', async () => {
    const fake = queryable({ activeRoots: 0, activeOwnerRoots: 0 });
    await expect(checkHeavyTaskAdmission(fake.queryable, request)).resolves.toMatchObject({
      allowed: true,
      inherited: false,
    });
    expect(fake.query.mock.calls[0]?.[0]).toContain('pg_advisory_xact_lock');
    const countSql = String(fake.query.mock.calls[2]?.[0]);
    expect(countSql).toContain('FROM generation_jobs');
    expect(countSql).toContain('FROM agent_sessions');
    expect(countSql).toContain('FROM agent_session_materials');
    expect(countSql.match(/UNION/g)).toHaveLength(2);
  });

  it('counts recoverable synchronous leases without holding advisory sessions open', async () => {
    const fake = queryable({
      activeRoots: 1,
      activeOwnerRoots: 1,
      relations: { generation_provider_slots: 'generation_provider_slots' },
    });
    fake.query.mockImplementationOnce(async () => ({ rows: [{}] }));
    fake.query.mockImplementationOnce(async () => ({
      rows: [
        {
          generation_jobs: 'generation_jobs',
          agent_sessions: 'agent_sessions',
          agent_session_materials: 'agent_session_materials',
          generation_provider_slots: 'generation_provider_slots',
        },
      ],
    }));
    fake.query.mockImplementationOnce(async (sql) => {
      expect(sql).toContain('DELETE FROM generation_provider_slots');
      return { rows: [] };
    });
    fake.query.mockImplementationOnce(async (sql, parameters) => {
      expect(sql).toContain('FROM generation_provider_slots');
      expect(sql).not.toContain('FROM pg_locks');
      expect(parameters).toEqual([
        'owner-a',
        'agent:root-a',
        90_000,
        80_000,
        'heavy-task:sync-owner:owner-a',
      ]);
      return { rows: [{ active_roots: '1', active_owner_roots: '1', inherited: false }] };
    });
    await expect(checkHeavyTaskAdmission(fake.queryable, request)).resolves.toMatchObject({
      allowed: false,
      reason: 'personal_limit',
    });
  });

  it('admits a second owner root and rejects the third before considering the site limit', async () => {
    const admitted = queryable({ activeRoots: 1, activeOwnerRoots: 1 });
    await expect(
      checkHeavyTaskAdmission(admitted.queryable, {
        ...request,
        siteLimit: 16,
        ownerLimit: 2,
      }),
    ).resolves.toEqual({
      allowed: true,
      inherited: false,
      activeRoots: 1,
      activeOwnerRoots: 1,
    });

    const fake = queryable({ activeRoots: 2, activeOwnerRoots: 2 });
    await expect(
      checkHeavyTaskAdmission(fake.queryable, { ...request, siteLimit: 16, ownerLimit: 2 }),
    ).resolves.toEqual({
      allowed: false,
      inherited: false,
      reason: 'personal_limit',
      activeRoots: 2,
      activeOwnerRoots: 2,
    });
  });

  it('rejects a new owner root when the configured site slots are full', async () => {
    const fake = queryable({ activeRoots: 1, activeOwnerRoots: 0 });
    await expect(checkHeavyTaskAdmission(fake.queryable, request)).resolves.toMatchObject({
      allowed: false,
      reason: 'site_limit',
    });
  });

  it('lets a child inherit its already-counted root without taking another slot', async () => {
    const fake = queryable({ activeRoots: 1, activeOwnerRoots: 1, inherited: true });
    await expect(checkHeavyTaskAdmission(fake.queryable, request)).resolves.toEqual({
      allowed: true,
      inherited: true,
      activeRoots: 1,
      activeOwnerRoots: 1,
    });
  });

  it('omits disabled queue relations instead of emitting invalid table references', async () => {
    const fake = queryable({
      activeRoots: 0,
      activeOwnerRoots: 0,
      relations: {
        generation_jobs: 'generation_jobs',
        agent_sessions: '' as never,
        agent_session_materials: '' as never,
      },
    });
    // Override the relation probe because the helper defaults undefined values to present.
    fake.query.mockImplementationOnce(async () => ({ rows: [{}] }));
    fake.query.mockImplementationOnce(async () => ({
      rows: [
        { generation_jobs: 'generation_jobs', agent_sessions: null, agent_session_materials: null },
      ],
    }));
    fake.query.mockImplementationOnce(async () => ({
      rows: [{ active_roots: 0, active_owner_roots: 0, inherited: false }],
    }));
    await checkHeavyTaskAdmission(fake.queryable, request);
    expect(fake.query.mock.calls[2]?.[1]).toEqual(['owner-a', 'agent:root-a']);
    const countSql = String(fake.query.mock.calls[2]?.[0]);
    expect(countSql).toContain('FROM generation_jobs');
    expect(countSql).not.toContain('FROM agent_sessions');
    expect(countSql).not.toContain('FROM agent_session_materials');
  });

  it('keeps one explicit root through async children and refuses root replacement', async () => {
    const root = { ownerId: 'owner-a', rootTaskId: 'agent:root-a', kind: 'agent' as const };
    await withHeavyTaskRootContext(root, async () => {
      await Promise.resolve();
      expect(getHeavyTaskRootContext()).toEqual(root);
      expect(() =>
        withHeavyTaskRootContext(
          { ownerId: 'owner-a', rootTaskId: 'agent:other', kind: 'media' },
          () => undefined,
        ),
      ).toThrow('replace its admitted root context');
    });
    expect(getHeavyTaskRootContext()).toBeUndefined();
  });

  it('counts distinct pure queued roots across the three queues with a configured site cap', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [{}] };
      if (sql.includes("to_regclass('generation_jobs')")) {
        return {
          rows: [
            {
              generation_jobs: 'generation_jobs',
              agent_sessions: 'agent_sessions',
              agent_session_materials: 'agent_session_materials',
            },
          ],
        };
      }
      expect(sql).toContain("generation_jobs WHERE status = 'queued'");
      expect(sql).toContain("agent_sessions WHERE status = 'queued'");
      expect(sql).toContain("material.extraction_status = 'pending'");
      expect(sql.match(/UNION/g)).toHaveLength(2);
      return { rows: [{ queued_roots: '100', queued_owner_roots: '4' }] };
    });
    await expect(
      checkHeavyTaskQueueCapacity(
        { query } as unknown as HeavyTaskAdmissionQueryable,
        {
          ownerId: 'owner-a',
          rootTaskId: 'generation:new',
        },
        { ownerLimit: 5, siteLimit: 100 },
      ),
    ).resolves.toEqual({
      allowed: false,
      reason: 'site_queue_limit',
      queuedRoots: 100,
      queuedOwnerRoots: 4,
    });
  });

  it('keeps manual-attention reservations inside a lowered configured slot range', async () => {
    const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
      if (sql.includes('INSERT INTO generation_provider_slots')) return { rows: [] };
      expect(sql).toContain('reservation.slot_no < $2');
      expect(parameters).toEqual(['00000000-0000-4000-8000-000000000001', 20]);
      return { rows: [{ slot_no: 19 }] };
    });
    await expect(
      reserveHeavyTaskAttention(
        { query } as unknown as HeavyTaskAdmissionQueryable,
        '00000000-0000-4000-8000-000000000001',
        20,
      ),
    ).resolves.toBe(true);
  });

  it('counts generation review and unanswered Pro questions in one attention backlog', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [{}] };
      if (sql.includes("to_regclass('generation_jobs')")) {
        return {
          rows: [
            {
              generation_jobs: 'generation_jobs',
              agent_sessions: 'agent_sessions',
              agent_session_events: 'agent_session_events',
            },
          ],
        };
      }
      expect(sql).toContain("status IN ('awaiting_confirmation', 'needs_attention')");
      expect(sql).toContain("question.type = 'user_question'");
      return { rows: [{ attention_roots: '5', attention_owner_roots: '5' }] };
    });
    await expect(
      checkHeavyTaskAttentionCapacity({ query } as unknown as HeavyTaskAdmissionQueryable, {
        ownerId: 'owner-a',
        rootTaskId: 'agent:new',
      }),
    ).resolves.toMatchObject({ allowed: false, reason: 'personal_attention_limit' });
  });

  it('admits only the oldest eligible root across generation, agent and material queues', async () => {
    const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
      if (sql.includes("to_regclass('generation_jobs')")) {
        return {
          rows: [
            {
              generation_jobs: 'generation_jobs',
              agent_sessions: 'agent_sessions',
              agent_session_materials: 'agent_session_materials',
            },
          ],
        };
      }
      expect(sql).toContain("status = 'queued'");
      expect(sql).toContain("material.extraction_status = 'pending'");
      expect(sql).toContain('ORDER BY queued_at, root_task_id');
      expect(sql).toContain('active_owner_counts');
      expect(sql).toContain('active_roots.root_task_id = queued_roots.root_task_id');
      expect(parameters).toEqual([
        'owner-a',
        'agent:root-a',
        90_000,
        80_000,
        -3_500_000,
        100_000,
        2,
      ]);
      return { rows: [{ candidate_present: true, oldest_root: 'generation:older' }] };
    });
    await expect(
      isHeavyTaskFairTurn({ query } as unknown as HeavyTaskAdmissionQueryable, {
        ...request,
        siteLimit: 16,
        ownerLimit: 2,
      }),
    ).resolves.toBe(false);
  });
});

describe('hosted heavy task aggregate boundary', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('uses the SECURITY DEFINER aggregate without selecting cross-owner rows', async () => {
    vi.stubEnv('AUTH_MODE', 'supabase');
    vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', 'supabase');
    const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
      expect(sql).toContain('app_internal.heavy_task_capacity');
      expect(parameters?.slice(0, 3)).toEqual(['admission', 'owner-a', 'agent:root-a']);
      expect(parameters?.slice(8, 10)).toEqual([2, 16]);
      return {
        rows: [
          {
            total_count: '15',
            owner_count: '1',
            inherited: false,
            candidate_present: false,
            oldest_root: null,
          },
        ],
      };
    });

    await expect(
      checkHeavyTaskAdmission({ query } as unknown as HeavyTaskAdmissionQueryable, {
        ...request,
        siteLimit: 16,
        ownerLimit: 2,
      }),
    ).resolves.toMatchObject({ allowed: true, activeRoots: 15, activeOwnerRoots: 1 });
    expect(query).toHaveBeenCalledOnce();
  });

  it('reserves attention only through the fenced function', async () => {
    vi.stubEnv('AUTH_MODE', 'supabase');
    const query = vi.fn(async (sql: string) => {
      expect(sql).toBe('SELECT app_internal.reserve_heavy_task_attention($1,$2) AS reserved');
      return { rows: [{ reserved: true }] };
    });
    await expect(
      reserveHeavyTaskAttention(
        { query } as unknown as HeavyTaskAdmissionQueryable,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        16,
      ),
    ).resolves.toBe(true);
  });
});
