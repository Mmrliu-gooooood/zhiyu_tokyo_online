import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GenerationTransactionQueue } from '@/lib/server/generation-jobs/transaction-queue';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Explicit isolated test database only. Never use DATABASE_URL/hosted credentials.
describe.skipIf(!process.env.TEST_GENERATION_DATABASE_URL)(
  'job transaction queue with real PG row locks',
  () => {
    const schema = `generation_queue_${randomUUID().replaceAll('-', '')}`;
    let admin: Pool;
    let pool: Pool;
    beforeAll(async () => {
      admin = new Pool({ connectionString: process.env.TEST_GENERATION_DATABASE_URL, max: 1 });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      await admin.query(
        `CREATE TABLE "${schema}".jobs(id text PRIMARY KEY, updates integer NOT NULL DEFAULT 0)`,
      );
      await admin.query(`INSERT INTO "${schema}".jobs(id) VALUES ('one'), ('two')`);
      pool = new Pool({
        connectionString: process.env.TEST_GENERATION_DATABASE_URL,
        max: 2,
        connectionTimeoutMillis: 200,
        options: `-c search_path=${schema}`,
      });
    });
    afterAll(async () => {
      await pool?.end();
      if (admin) {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.end();
      }
    });

    it('reproduces checkout starvation when same-job SQL waiters occupy both pool clients', async () => {
      const first = await pool.connect();
      const second = await pool.connect();
      let waiting: Promise<unknown> | undefined;
      try {
        await first.query('BEGIN');
        await first.query("SELECT * FROM jobs WHERE id='one' FOR UPDATE");
        await second.query('BEGIN');
        waiting = second.query("SELECT * FROM jobs WHERE id='one' FOR UPDATE");
        await expect(pool.query('SELECT 1')).rejects.toThrow(/timeout/i);
        await first.query('COMMIT');
        await waiting;
        await second.query('COMMIT');
      } finally {
        await first.query('ROLLBACK');
        await waiting;
        await second.query('ROLLBACK');
        first.release();
        second.release();
      }
    });

    it('queues before checkout so an unrelated job runs and heartbeat precedes queued mutations', async () => {
      const queue = new GenerationTransactionQueue();
      const entered = deferred();
      const unblock = deferred();
      const events: string[] = [];
      const transaction =
        (job: string, label: string, hold = false) =>
        async () => {
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            await client.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE', [job]);
            events.push(label);
            if (hold) {
              entered.resolve();
              await unblock.promise;
            }
            await client.query('UPDATE jobs SET updates=updates+1 WHERE id=$1', [job]);
            await client.query('COMMIT');
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          } finally {
            client.release();
          }
        };
      const first = queue.run('one', transaction('one', 'held', true));
      await entered.promise;
      const mutation = queue.run('one', transaction('one', 'mutation'));
      const heartbeat = queue.run('one', transaction('one', 'heartbeat'), true);
      try {
        await queue.run('two', transaction('two', 'unrelated'));
        expect(pool.waitingCount).toBe(0);
        expect(pool.totalCount - pool.idleCount).toBe(1);
      } finally {
        unblock.resolve();
        await Promise.all([first, mutation, heartbeat]);
      }
      expect(events).toEqual(['held', 'unrelated', 'heartbeat', 'mutation']);
      const result = await pool.query('SELECT id, updates FROM jobs ORDER BY id');
      expect(result.rows).toEqual([
        { id: 'one', updates: 3 },
        { id: 'two', updates: 1 },
      ]);
      await vi.waitFor(() => expect(pool.totalCount - pool.idleCount).toBe(0));
    });
  },
);
