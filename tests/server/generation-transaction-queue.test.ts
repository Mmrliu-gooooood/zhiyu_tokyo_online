import { describe, expect, it } from 'vitest';
import { GenerationJobRepository } from '@/lib/server/generation-jobs/repository';
import { GenerationTransactionQueue } from '@/lib/server/generation-jobs/transaction-queue';
import type { GenerationLease } from '@/lib/server/generation-jobs/contracts';
import type { TransactionSource } from '@/lib/persistence/owner-bound-document-store';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function lease(jobId: string): GenerationLease {
  return {
    jobId,
    stageId: `stage-${jobId}`,
    ownerId: 'owner',
    workerId: 'worker',
    leaseEpoch: 1,
    ownershipEpoch: 1,
    planRevision: 1,
    input: { version: 1, requirements: { requirement: 'fixture' }, review: { mode: 'auto' } },
  };
}

describe('generation transaction checkout scheduling', () => {
  it('keeps same-job lock waiters out of a bounded pool, prioritizes heartbeat and allows another job', async () => {
    const entered = deferred();
    const unblock = deferred();
    const events: string[] = [];
    let active = 0;
    let peak = 0;
    let checkouts = 0;
    const pool: TransactionSource = {
      async connect() {
        // Fail immediately instead of waiting ten real seconds for a pool slot.
        // Two connections suffice for the held transaction and unrelated job.
        if (active === 2) throw new Error('pool checkout timeout');
        active += 1;
        checkouts += 1;
        peak = Math.max(peak, active);
        return {
          async query(sql: string, params?: unknown[]) {
            const jobId = String(params?.[0]);
            if (sql.startsWith('SELECT * FROM generation_jobs'))
              return {
                rows: [
                  {
                    status: 'running',
                    worker_id: 'worker',
                    lease_epoch: 1,
                    plan_revision: 1,
                  },
                ],
              };
            if (sql.includes('AS alive')) return { rows: [{ alive: true }] };
            if (sql.startsWith('SELECT * FROM generation_ownership'))
              return {
                rows: [
                  {
                    owner_id: 'owner',
                    producer_kind: 'course-worker',
                    producer_ref: jobId.replace('stage-', ''),
                    ownership_epoch: 1,
                    write_mode: 'generating',
                  },
                ],
              };
            if (sql.includes('FROM stage_meta'))
              return { rows: [{ owner_id: 'owner', deleted_at: null }] };
            if (sql.includes('FROM document_stages')) return { rows: [{ owner_id: 'owner' }] };
            if (sql.startsWith('SELECT EXISTS')) return { rows: [{ changed: false }] };
            if (sql.startsWith('SELECT * FROM generation_steps')) {
              events.push(`checkpoint:${params?.[1]}`);
              if (params?.[1] === 'slow') {
                entered.resolve();
                await unblock.promise;
              }
              return { rows: [] };
            }
            if (sql.startsWith('UPDATE generation_jobs')) {
              events.push(`heartbeat:${jobId}`);
              return { rows: [{ id: jobId }] };
            }
            return { rows: [] };
          },
          release() {
            active -= 1;
          },
        };
      },
    };
    const repository = new GenerationJobRepository(pool);
    const first = repository.getCheckpoint(lease('one'), 'slow');
    await entered.promise;
    const queued = repository.getCheckpoint(lease('one'), 'queued');
    const heartbeat = repository.heartbeat(lease('one'));
    // Queued same-job operations must not even attempt pool.connect().
    expect(checkouts).toBe(1);
    await expect(repository.getCheckpoint(lease('two'), 'other-job')).resolves.toBeUndefined();
    expect(active).toBe(1);
    unblock.resolve();
    await expect(heartbeat).resolves.toBe(true);
    await Promise.all([first, queued]);
    expect(events).toEqual([
      'checkpoint:slow',
      'checkpoint:other-job',
      'heartbeat:one',
      'checkpoint:queued',
    ]);
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });

  it('releases the queue after failure and does not serialize provider work between transactions', async () => {
    const queue = new GenerationTransactionQueue();
    const providerStarted = deferred();
    const providerDone = deferred();
    const events: string[] = [];
    const task = (async () => {
      await queue.run('one', async () => {
        events.push('begin');
      });
      providerStarted.resolve();
      await providerDone.promise;
      await queue.run('one', async () => {
        events.push('commit');
      });
    })();
    await providerStarted.promise;
    await queue.run(
      'one',
      async () => {
        events.push('heartbeat');
      },
      true,
    );
    const failed = queue.run('one', async () => {
      throw new Error('transaction rolled back');
    });
    await expect(failed).rejects.toThrow('transaction rolled back');
    await queue.run('one', async () => {
      events.push('next');
    });
    providerDone.resolve();
    await task;
    expect(events).toEqual(['begin', 'heartbeat', 'next', 'commit']);
  });
});
