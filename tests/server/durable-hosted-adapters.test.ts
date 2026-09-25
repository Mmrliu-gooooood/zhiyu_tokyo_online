import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  rootOwner: undefined as string | undefined,
  boundOwners: [] as string[],
  renderOwners: new Map<string, string>(),
  snapshots: new Map<
    string,
    { ownerId: string; storageRef: string; version: number; stageId: string }
  >(),
  jobs: new Map<string, { ownerId: string; payload: Record<string, unknown> }>(),
  usageRows: [] as unknown[][],
  usageEventKeys: new Set<string>(),
  usageReadRows: [] as Record<string, unknown>[],
}));

async function fakeQuery(ownerId: string, sql: string, params: unknown[] = []) {
  const normalized = sql.replace(/\s+/g, ' ').trim();
  if (normalized.startsWith('INSERT INTO render_job_owners')) {
    const [jobId, rowOwner] = params as string[];
    const existing = state.renderOwners.get(jobId);
    if (existing && existing !== rowOwner) return { rows: [] };
    state.renderOwners.set(jobId, rowOwner);
    return { rows: [{ job_id: jobId }] };
  }
  if (normalized.startsWith('SELECT owner_id FROM render_job_owners')) {
    const recorded = state.renderOwners.get(String(params[0]));
    return { rows: recorded === ownerId ? [{ owner_id: recorded }] : [] };
  }
  if (normalized.startsWith('INSERT INTO usage_events')) {
    const eventKey = `${String(params[0])}:${String(params[1])}`;
    if (state.usageEventKeys.has(eventKey)) return { rows: [] };
    state.usageEventKeys.add(eventKey);
    state.usageRows.push(params);
    return { rows: [] };
  }
  if (normalized.includes('FROM usage_events')) return { rows: state.usageReadRows };
  if (normalized.includes('FROM classroom_snapshots')) {
    const row = state.snapshots.get(String(params[0]));
    return {
      rows:
        row?.ownerId === ownerId
          ? [
              {
                owner_id: row.ownerId,
                storage_ref: row.storageRef,
                version: row.version,
              },
            ]
          : [],
    };
  }
  if (normalized.startsWith('INSERT INTO classroom_snapshots')) {
    const [classroomId, rowOwner, stageId, storageRef, version] = params;
    if (state.snapshots.has(String(classroomId))) {
      throw Object.assign(new Error('duplicate'), { code: '23505' });
    }
    state.snapshots.set(String(classroomId), {
      ownerId: String(rowOwner),
      stageId: String(stageId),
      storageRef: String(storageRef),
      version: Number(version),
    });
    return { rows: [] };
  }
  if (normalized.startsWith('UPDATE classroom_snapshots')) {
    const [stageId, storageRef, version, classroomId, rowOwner, priorVersion] = params;
    const row = state.snapshots.get(String(classroomId));
    if (!row || row.ownerId !== rowOwner || row.version !== Number(priorVersion)) {
      return { rows: [] };
    }
    state.snapshots.set(String(classroomId), {
      ownerId: String(rowOwner),
      stageId: String(stageId),
      storageRef: String(storageRef),
      version: Number(version),
    });
    return { rows: [{ classroom_id: classroomId }] };
  }
  if (normalized.startsWith('INSERT INTO classroom_generation_jobs')) {
    const [jobId, rowOwner, payload] = params;
    state.jobs.set(String(jobId), {
      ownerId: String(rowOwner),
      payload: JSON.parse(String(payload)) as Record<string, unknown>,
    });
    return { rows: [] };
  }
  if (normalized.includes('FROM classroom_generation_jobs')) {
    const job = state.jobs.get(String(params[0]));
    return { rows: job?.ownerId === ownerId ? [{ payload: job.payload }] : [] };
  }
  if (normalized.startsWith('UPDATE classroom_generation_jobs')) {
    const [payload, jobId, rowOwner] = params;
    const job = state.jobs.get(String(jobId));
    if (!job || job.ownerId !== rowOwner) return { rows: [] };
    job.payload = JSON.parse(String(payload)) as Record<string, unknown>;
    return { rows: [] };
  }
  throw new Error(`unexpected SQL: ${normalized}`);
}

vi.mock('@/lib/auth/mode', () => ({
  isHostedAuthEnabled: () => process.env.AUTH_MODE === 'supabase',
}));
vi.mock('@/lib/db/pool-registry', () => ({ getPersistencePool: () => ({}) }));
vi.mock('@/lib/db/request-queryable', () => ({
  createOwnerBoundQueryable: (_pool: unknown, ownerId: string) => {
    state.boundOwners.push(ownerId);
    const queryable = {
      query: (sql: string, params?: unknown[]) => fakeQuery(ownerId, sql, params),
    };
    return {
      ...queryable,
      withTransaction: <T>(body: (query: typeof queryable) => Promise<T>) => body(queryable),
    };
  },
}));
vi.mock('@/lib/server/heavy-task-admission', () => ({
  getHeavyTaskRootContext: () =>
    state.rootOwner
      ? { ownerId: state.rootOwner, rootTaskId: 'root-1', kind: 'generation' }
      : undefined,
}));

import { assertRenderJobOwner, recordRenderJobOwner } from '@/lib/server/render-job-owners';
import { readUsageRecords, recordUsage } from '@/lib/server/usage-storage';
import { persistClassroom, readClassroom } from '@/lib/server/classroom-storage';
import {
  ClassroomSnapshotS3Store,
  setClassroomSnapshotStoreForTests,
  type ClassroomSnapshotStore,
} from '@/lib/server/classroom-snapshot-store';
import {
  createClassroomGenerationJob,
  markClassroomGenerationJobRunning,
  readClassroomGenerationJob,
} from '@/lib/server/classroom-job-store';

const owner = 'user:11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.stubEnv('AUTH_MODE', 'supabase');
  state.rootOwner = owner;
  state.boundOwners.length = 0;
  state.renderOwners.clear();
  state.snapshots.clear();
  state.jobs.clear();
  state.usageRows.length = 0;
  state.usageEventKeys.clear();
  state.usageReadRows.length = 0;
  const objects = new Map<string, Uint8Array>();
  let next = 0;
  const store: ClassroomSnapshotStore = {
    async put({ bytes }) {
      const ref = `s3://private/snapshot-${++next}.json`;
      objects.set(ref, bytes);
      return ref;
    },
    async get(ref) {
      const bytes = objects.get(ref);
      if (!bytes) throw new Error('missing snapshot');
      return bytes;
    },
  };
  setClassroomSnapshotStoreForTests(store);
});

describe('hosted durable adapters', () => {
  it('uses immutable content-addressed keys for private classroom snapshots', async () => {
    const commands: unknown[] = [];
    const store = new ClassroomSnapshotS3Store({
      bucket: 'private-classrooms',
      client: {
        async send(command) {
          commands.push(command);
          return command;
        },
      },
      putCommand: (input) => input,
      getCommand: (input) => ({
        ...input,
        Body: { transformToByteArray: async () => new Uint8Array([123, 125]) },
      }),
    });
    const ref = await store.put({
      ownerId: owner,
      classroomId: 'class-1',
      version: 2,
      bytes: new TextEncoder().encode('{}'),
    });
    expect(ref).toMatch(
      /^s3:\/\/private-classrooms\/snapshots\/user%3A.*\/class-1\/2-[a-f0-9]{64}\.json$/,
    );
    await expect(store.get('s3://another-bucket/snapshot.json')).rejects.toThrow(
      'INVALID_CLASSROOM_STORAGE_BUCKET',
    );
    expect(commands).toHaveLength(1);
  });

  it('stores and verifies render ownership through an owner-bound database query', async () => {
    await recordRenderJobOwner('render-1', owner);
    await expect(assertRenderJobOwner('render-1', owner)).resolves.toBe(true);
    await expect(
      assertRenderJobOwner('render-1', 'user:22222222-2222-4222-8222-222222222222'),
    ).resolves.toBe(false);
  });

  it('persists full-fidelity, idempotent usage fields and reads them owner-scoped', async () => {
    const input = {
      source: 'worker',
      providerId: 'openai',
      modelId: 'gpt-test',
      modelString: 'openai:gpt-test',
      eventKey: 'evt-1',
      jobId: 'job-1',
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 3,
        cacheCreationTokens: 2,
        reasoningTokens: 1,
      },
    } as const;
    await recordUsage(input);
    await recordUsage(input);
    expect(state.usageRows).toHaveLength(1);
    expect(state.usageRows[0].slice(0, 11)).toEqual([
      owner,
      'evt-1',
      'worker',
      'llm',
      'job-1',
      null,
      null,
      'openai:gpt-test',
      'openai',
      'gpt-test',
      'openai:gpt-test',
    ]);

    state.usageReadRows.push({
      id: '9',
      created_at: '2026-09-21T00:00:00.000Z',
      kind: 'llm',
      source: 'worker',
      provider_id: 'openai',
      model_id: 'gpt-test',
      model_string: 'openai:gpt-test',
      model: 'openai:gpt-test',
      input_tokens: 10,
      output_tokens: 4,
      cache_read_tokens: 3,
      cache_creation_tokens: 2,
      reasoning_tokens: 1,
      quantity: null,
      unit: null,
      owner_id: owner,
    });
    const rows = await readUsageRecords({ ownerId: owner, months: ['2026-09'] });
    expect(rows[0]).toMatchObject({ ownerId: owner, cacheReadTokens: 3, reasoningTokens: 1 });
  });

  it('writes immutable classroom snapshots and advances the database version', async () => {
    const first = await persistClassroom(
      { id: 'class-1', stage: { id: 'stage-1' } as never, scenes: [], ownerId: owner },
      'http://localhost:3000',
    );
    expect(first.ownerId).toBe(owner);
    expect(state.snapshots.get('class-1')?.version).toBe(1);
    const loaded = await readClassroom('class-1', owner);
    expect(loaded).toMatchObject({ id: 'class-1', ownerId: owner });

    await persistClassroom(
      { id: 'class-1', stage: { id: 'stage-1' } as never, scenes: [], ownerId: owner },
      'http://localhost:3000',
    );
    expect(state.snapshots.get('class-1')?.version).toBe(2);
  });

  it('persists classroom job recovery state as owner-scoped JSONB', async () => {
    await createClassroomGenerationJob('job-1', { requirement: 'Teach fractions' }, owner);
    await markClassroomGenerationJobRunning('job-1', owner);
    const job = await readClassroomGenerationJob('job-1', owner);
    expect(job).toMatchObject({ id: 'job-1', status: 'running' });
    expect(state.jobs.get('job-1')?.ownerId).toBe(owner);
  });
});
