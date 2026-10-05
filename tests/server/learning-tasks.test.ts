/**
 * learning_tasks queue (learning plan B02): idempotent enqueue, shared
 * heavy-task capacity, lease-fenced claim/settle, retry backoff, worker-crash
 * recovery, cancellation and queue expiry. Runs on PGlite (non-hosted SQL path).
 */
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureDocumentSchema } from '@openmaic/storage/document/pg';
import type { Queryable } from '@openmaic/storage/document/pg';
import { ensureAssetSchema } from '@openmaic/storage/asset/pg';

import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import { migrateGenerationSchema } from '@/lib/server/generation-jobs/migrations';
import { ensureStudySchema } from '@/lib/server/study/schema';
import {
  checkHeavyTaskAdmission,
  checkHeavyTaskQueueCapacity,
} from '@/lib/server/heavy-task-admission';
import {
  LearningTaskQueue,
  cancelLearningTask,
  enqueueLearningTask,
  getLearningTask,
  isLearningTaskWorkerLive,
  retryLearningTask,
} from '@/lib/server/learning-tasks/repository';
import { LearningTaskError, type LearningTaskLease } from '@/lib/server/learning-tasks/contracts';
import { startLearningTaskRunner } from '@/lib/server/learning-tasks/runner';

const OWNER_A = 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_B = 'user:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

class TestPool {
  constructor(readonly db: PGlite) {}
  query<R extends Record<string, unknown>>(sql: string, args?: unknown[]) {
    return this.db.query<R>(sql, args);
  }
  async connect() {
    return { query: (sql: string, args?: unknown[]) => this.db.query(sql, args), release() {} };
  }
}

let db: PGlite;
let pool: TestPool;
let queue: LearningTaskQueue;

function q(): Queryable {
  return {
    query: async (sql, params) => ({ rows: (await db.query(sql, params ?? [])).rows as never[] }),
  };
}

function enqueue(
  owner: string,
  key: string,
  input: Record<string, unknown> = { providerId: 'unpdf' },
) {
  return enqueueLearningTask(q(), {
    ownerId: owner,
    kind: 'material_parse',
    subjectId: `ver-${key}`,
    idempotencyKey: key,
    input,
  });
}

async function claim(worker = 'w1'): Promise<LearningTaskLease> {
  const lease = await queue.claim(worker, ['material_parse']);
  if (!lease) throw new Error('expected a claim');
  return lease;
}

beforeEach(async () => {
  db = new PGlite();
  pool = new TestPool(db);
  await ensureDocumentSchema(q());
  await ensureStageMetaSchema(q());
  await ensureStudySchema(q());
  await ensureAssetSchema(q());
  await migrateGenerationSchema(pool as never);
  queue = new LearningTaskQueue(pool as never, { leaseMs: 60_000, queueWaitMs: 3_600_000 });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await db.close();
});

describe('learning task enqueue', () => {
  it('is idempotent per owner key and rejects a different request under the same key', async () => {
    const first = await enqueue(OWNER_A, 'k1');
    expect(first.created).toBe(true);
    expect(first.task.status).toBe('queued');
    const again = await enqueue(OWNER_A, 'k1');
    expect(again.created).toBe(false);
    expect(again.task.taskId).toBe(first.task.taskId);
    await expect(enqueue(OWNER_A, 'k1', { providerId: 'mineru' })).rejects.toMatchObject({
      code: 'LEARNING_TASK_IDEMPOTENCY_CONFLICT',
    });
    // Another owner may use the same key independently.
    expect((await enqueue(OWNER_B, 'k1')).created).toBe(true);
  });

  it('counts queued learning roots in the shared personal queue capacity', async () => {
    for (let index = 0; index < 5; index += 1) await enqueue(OWNER_A, `cap-${index}`);
    await expect(enqueue(OWNER_A, 'cap-5')).rejects.toMatchObject({
      code: 'LEARNING_TASK_OWNER_QUEUE_LIMIT',
      httpStatus: 429,
    });
    // A course-generation root of the same owner sees the same backlog.
    const decision = await checkHeavyTaskQueueCapacity(q(), {
      ownerId: OWNER_A,
      rootTaskId: 'generation:other',
    });
    expect(decision).toMatchObject({ allowed: false, queuedOwnerRoots: 5 });
    expect((await enqueue(OWNER_B, 'cap-b')).created).toBe(true);
  });
});

describe('learning task leases', () => {
  it('claims, heartbeats and settles inside one lease-fenced commit', async () => {
    const { task } = await enqueue(OWNER_A, 'run');
    const lease = await claim();
    expect(lease).toMatchObject({ taskId: task.taskId, attemptNo: 1, kind: 'material_parse' });
    expect(lease.input).toEqual({ providerId: 'unpdf' });
    expect(await queue.heartbeat(lease)).toBe(true);
    const committed = await queue.complete(
      lease,
      { result: { artifactId: 'art-1' }, providerId: 'unpdf', usageCompleteness: 'complete' },
      async (tx) => {
        await tx.query(
          "INSERT INTO generation_worker_heartbeats(worker_id,pipeline_versions) VALUES('commit-probe','[]')",
        );
      },
    );
    expect(committed).toBe(true);
    const probe = await db.query(
      "SELECT 1 FROM generation_worker_heartbeats WHERE worker_id='commit-probe'",
    );
    expect(probe.rows).toHaveLength(1);
    const done = await getLearningTask(q(), OWNER_A, task.taskId);
    expect(done).toMatchObject({ status: 'succeeded', result: { artifactId: 'art-1' } });
    const attempts = await db.query<{ outcome: string; provider_id: string }>(
      'SELECT outcome, provider_id FROM learning_task_attempts WHERE task_id=$1',
      [task.taskId],
    );
    expect(attempts.rows).toEqual([{ outcome: 'succeeded', provider_id: 'unpdf' }]);
    expect(await getLearningTask(q(), OWNER_B, task.taskId)).toBeNull();
  });

  it('holds a running learning root against the site-wide heavy-task limit', async () => {
    await enqueue(OWNER_A, 'site-a');
    await enqueue(OWNER_B, 'site-b');
    const lease = await claim();
    expect(lease.ownerId).toBe(OWNER_A);
    // APP_HEAVY_TASK_LIMIT defaults to 1: the second owner waits.
    expect(await queue.claim('w2', ['material_parse'])).toBeNull();
    const admission = await checkHeavyTaskAdmission(q(), {
      ownerId: OWNER_B,
      rootTaskId: 'generation:x',
      kind: 'generation',
      agentLeaseTtlMs: 60_000,
    });
    expect(admission).toMatchObject({ allowed: false, reason: 'site_limit', activeRoots: 1 });
    const view = await getLearningTask(
      q(),
      OWNER_B,
      (await enqueue(OWNER_B, 'site-b')).task.taskId,
    );
    expect(view?.queueReason).toBe('site_limit');
    await queue.complete(lease, { result: {} });
    expect((await claim('w2')).ownerId).toBe(OWNER_B);
  });

  it('retries with backoff, then fails terminally when attempts run out', async () => {
    const { task } = await enqueue(OWNER_A, 'retry');
    const first = await claim();
    await queue.fail(first, { code: 'PROVIDER_TIMEOUT', retryable: true, summary: 'timeout' });
    let view = await getLearningTask(q(), OWNER_A, task.taskId);
    expect(view).toMatchObject({ status: 'retry_wait', lastErrorCode: 'PROVIDER_TIMEOUT' });
    expect(await queue.claim('w1', ['material_parse'])).toBeNull();
    await db.query('UPDATE learning_tasks SET available_at=clock_timestamp() WHERE id=$1', [
      task.taskId,
    ]);
    const second = await claim();
    expect(second.attemptNo).toBe(2);
    await queue.fail(second, { code: 'not a code!', retryable: false });
    view = await getLearningTask(q(), OWNER_A, task.taskId);
    expect(view).toMatchObject({
      status: 'failed',
      lastErrorCode: 'LEARNING_TASK_FAILED',
      retryable: true,
    });
    const retried = await retryLearningTask(q(), OWNER_A, task.taskId);
    expect(retried).toMatchObject({ status: 'queued', maxAttempts: 5, lastErrorCode: null });
  });

  it('recovers a task whose worker died, and fences the old holder out', async () => {
    const { task } = await enqueue(OWNER_A, 'crash');
    const dead = await claim('dead-worker');
    await db.query(
      "UPDATE learning_tasks SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [task.taskId],
    );
    expect(await queue.reapExpired()).toBe(1);
    expect(await getLearningTask(q(), OWNER_A, task.taskId)).toMatchObject({
      status: 'retry_wait',
      lastErrorCode: 'WORKER_LEASE_EXPIRED',
    });
    const fresh = await claim('restarted-worker');
    expect(fresh.leaseEpoch).toBeGreaterThan(dead.leaseEpoch);
    expect(await queue.heartbeat(dead)).toBe(false);
    expect(await queue.complete(dead, { result: { stale: true } })).toBe(false);
    expect(await queue.complete(fresh, { result: { fresh: true } })).toBe(true);
    expect(await getLearningTask(q(), OWNER_A, task.taskId)).toMatchObject({
      status: 'succeeded',
      result: { fresh: true },
    });
    const outcomes = await db.query<{ attempt_no: number; outcome: string }>(
      'SELECT attempt_no, outcome FROM learning_task_attempts WHERE task_id=$1 ORDER BY attempt_no',
      [task.taskId],
    );
    expect(outcomes.rows).toEqual([
      { attempt_no: 1, outcome: 'lease_lost' },
      { attempt_no: 2, outcome: 'succeeded' },
    ]);
  });

  it('does not silently repeat a possibly charged external attempt after a crash', async () => {
    const { task } = await enqueue(OWNER_A, 'paid', {
      providerId: 'mineru-cloud',
      externalCost: true,
    });
    await claim();
    await db.query(
      "UPDATE learning_tasks SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [task.taskId],
    );
    await queue.reapExpired();
    expect(await getLearningTask(q(), OWNER_A, task.taskId)).toMatchObject({
      status: 'failed',
      lastErrorCode: 'EXTERNAL_RESULT_UNKNOWN',
      usageCompleteness: 'unknown',
      retryable: true,
    });
  });

  it('cancels a running task and rejects its late result', async () => {
    const { task } = await enqueue(OWNER_A, 'cancel');
    const lease = await claim();
    await expect(cancelLearningTask(q(), OWNER_B, task.taskId)).rejects.toBeInstanceOf(
      LearningTaskError,
    );
    expect((await cancelLearningTask(q(), OWNER_A, task.taskId)).status).toBe('cancelled');
    expect(await queue.heartbeat(lease)).toBe(false);
    expect(await queue.complete(lease, { result: {} })).toBe(false);
    expect((await getLearningTask(q(), OWNER_A, task.taskId))?.status).toBe('cancelled');
    const attempt = await db.query<{ outcome: string }>(
      'SELECT outcome FROM learning_task_attempts WHERE task_id=$1',
      [task.taskId],
    );
    expect(attempt.rows[0]?.outcome).toBe('cancelled');
  });

  it('expires tasks that waited past the queue deadline', async () => {
    const { task } = await enqueue(OWNER_A, 'old');
    await db.query("UPDATE learning_tasks SET updated_at=clock_timestamp()-interval '2 hours'");
    expect(await queue.claim('w1', ['material_parse'])).toBeNull();
    expect(await queue.expireQueued()).toBe(1);
    expect(await getLearningTask(q(), OWNER_A, task.taskId)).toMatchObject({
      status: 'failed',
      lastErrorCode: 'QUEUE_WAIT_EXPIRED',
    });
  });

  it('publishes a learning worker capability that readiness can see, and drains it', async () => {
    expect(await isLearningTaskWorkerLive(q())).toBe(false);
    await queue.workerHeartbeat('host-1');
    expect(await isLearningTaskWorkerLive(q())).toBe(true);
    await queue.workerHeartbeat('host-1', true);
    expect(await isLearningTaskWorkerLive(q())).toBe(false);
  });
});

describe('learning task runner', () => {
  function fakeQueue(lease: LearningTaskLease | null) {
    let handed = false;
    return {
      claim: vi.fn(async () => {
        if (handed || !lease) return null;
        handed = true;
        return lease;
      }),
      heartbeat: vi.fn(async () => true),
      fail: vi.fn(async () => true),
      complete: vi.fn(async () => true),
      workerHeartbeat: vi.fn(async () => undefined),
      reapExpired: vi.fn(async () => 0),
      expireQueued: vi.fn(async () => 0),
    };
  }
  const lease: LearningTaskLease = {
    taskId: '00000000-0000-4000-8000-000000000001',
    ownerId: OWNER_A,
    rootTaskId: 'learning:00000000-0000-4000-8000-000000000001',
    kind: 'material_parse',
    subjectId: 'ver-1',
    input: {},
    workerId: 'w',
    leaseEpoch: 1,
    attemptId: 'a',
    attemptNo: 1,
    deadlineAt: Date.now() + 60_000,
  };

  it('dispatches by kind and settles a thrown, classified failure', async () => {
    const fake = fakeQueue(lease);
    const handler = vi.fn(async () => {
      throw Object.assign(new Error('provider down'), { code: 'PARSER_TIMEOUT', retryable: true });
    });
    const runner = startLearningTaskRunner({
      queue: fake as never,
      handlers: { material_parse: handler },
      scanIntervalMs: 10,
      heartbeatMs: 10,
    });
    await vi.waitFor(() => expect(fake.fail).toHaveBeenCalled());
    expect(fake.fail).toHaveBeenCalledWith(
      lease,
      expect.objectContaining({ code: 'PARSER_TIMEOUT', retryable: true }),
    );
    await runner.stop();
    expect(fake.workerHeartbeat).toHaveBeenLastCalledWith(runner.workerId, true);
  });

  it('drains on stop: aborts a task past the grace period and re-queues it', async () => {
    const fake = fakeQueue(lease);
    let started = false;
    const handler = vi.fn(
      (_lease: LearningTaskLease, context: { signal: AbortSignal }) =>
        new Promise<void>((_resolve, reject) => {
          started = true;
          context.signal.addEventListener('abort', () => reject(context.signal.reason));
        }),
    );
    const runner = startLearningTaskRunner({
      queue: fake as never,
      handlers: { material_parse: handler },
      scanIntervalMs: 10,
      heartbeatMs: 1000,
      drainTimeoutMs: 50,
    });
    await vi.waitFor(() => expect(started).toBe(true));
    await runner.stop();
    expect(fake.fail).toHaveBeenCalledWith(
      lease,
      expect.objectContaining({ code: 'WORKER_DRAIN_TIMEOUT', retryable: true }),
    );
  });

  it('never settles a task whose lease was lost', async () => {
    const fake = fakeQueue(lease);
    fake.heartbeat.mockResolvedValue(false);
    const handler = vi.fn(
      (_lease: LearningTaskLease, context: { signal: AbortSignal }) =>
        new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(context.signal.reason));
        }),
    );
    const runner = startLearningTaskRunner({
      queue: fake as never,
      handlers: { material_parse: handler },
      scanIntervalMs: 10,
      heartbeatMs: 10,
    });
    await vi.waitFor(() => expect(handler).toHaveBeenCalled());
    await vi.waitFor(() => expect(fake.heartbeat).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 50));
    await runner.stop();
    expect(fake.fail).not.toHaveBeenCalled();
  });
});
