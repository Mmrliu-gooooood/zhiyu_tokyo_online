import { describe, expect, it, vi } from 'vitest';

import {
  checkHeavyTaskAdmission,
  checkHeavyTaskQueueCapacity,
  getHeavyTaskRootContext,
  heavyTaskSiteLimit,
  withHeavyTaskRootContext,
  type HeavyTaskAdmissionQueryable,
} from '@/lib/server/heavy-task-admission';

function queryable(input: {
  activeRoots: number;
  activeOwnerRoots: number;
  inherited?: boolean;
  relations?: Partial<
    Record<'generation_jobs' | 'agent_sessions' | 'agent_session_materials', string>
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

  it('defaults to one site slot and only permits the validated scale-up value', () => {
    expect(heavyTaskSiteLimit({})).toBe(1);
    expect(heavyTaskSiteLimit({ APP_HEAVY_TASK_LIMIT: ' 2 ' })).toBe(2);
    expect(() => heavyTaskSiteLimit({ APP_HEAVY_TASK_LIMIT: '3' })).toThrow(
      'APP_HEAVY_TASK_LIMIT must be 1 or 2',
    );
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

  it('rejects another root from the same owner before considering the site limit', async () => {
    const fake = queryable({ activeRoots: 2, activeOwnerRoots: 1 });
    await expect(
      checkHeavyTaskAdmission(fake.queryable, { ...request, siteLimit: 2 }),
    ).resolves.toEqual({
      allowed: false,
      inherited: false,
      reason: 'personal_limit',
      activeRoots: 2,
      activeOwnerRoots: 1,
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

  it('counts distinct pure queued roots across the three queues with fixed 5/20 caps', async () => {
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
      return { rows: [{ queued_roots: '20', queued_owner_roots: '4' }] };
    });
    await expect(
      checkHeavyTaskQueueCapacity({ query } as unknown as HeavyTaskAdmissionQueryable, {
        ownerId: 'owner-a',
        rootTaskId: 'generation:new',
      }),
    ).resolves.toEqual({
      allowed: false,
      reason: 'site_queue_limit',
      queuedRoots: 20,
      queuedOwnerRoots: 4,
    });
  });
});
