/**
 * Accounts v32 (AI practice, learning plan B11): registered and repeatable;
 * practice jobs force row security and are granted only to app_web
 * (owner-bound, no worker access); calls never pass the cap; attempts get a
 * bounded `assistance` object; the repository runs under row security — one
 * step holds a job at a time, a finished step needs its lease token, another
 * owner sees and claims nothing — help is recorded only on open practice
 * attempts, and jobs cascade from their space.
 *
 * Runs on PGlite always; set TEST_STUDY_PRACTICE_DATABASE_URL to a dedicated
 * disposable *_rls_proof database on 127.0.0.1:55432 to repeat it on real
 * PostgreSQL.
 */
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { ACCOUNT_MIGRATIONS, accountsMigrationChecksum } from '@/lib/server/accounts/migrations';
import { ACCOUNTS_SCHEMA_VERSION } from '@/lib/server/accounts/sql-accounts';
import { ACCOUNTS_MIGRATION_28 } from '@/lib/server/accounts/sql-study-exams';
import { ACCOUNTS_MIGRATION_30 } from '@/lib/server/accounts/sql-study-grading';
import {
  ACCOUNTS_MIGRATION_32,
  STUDY_PRACTICE_TABLES,
} from '@/lib/server/accounts/sql-study-practice';
import { ACCOUNTS_MIGRATION_31 } from '@/lib/server/accounts/sql-study-wrongbook';
import { getAttemptView, recordAssistance } from '@/lib/server/study/exams/repository';
import {
  claimPracticeStep,
  finishPracticeStep,
  getPracticeJob,
  insertPracticeJob,
  lockClaimedJob,
  setPracticeStatus,
} from '@/lib/server/study/practice/repository';
import type { StudyDb } from '@/lib/server/study/spaces/repository';
import type { VariantJobRequest } from '@/lib/study/practice/contracts';
import { applySql } from '@/tests/helpers/model-credentials-db';
import type { Queryable } from '@openmaic/storage/document/pg';

const OWNER_A = 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_B = 'user:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const DROP = `DROP TABLE IF EXISTS study_practice_jobs, study_wrong_occurrences, study_wrong_items,
  study_exam_gradings, study_exam_attempts, study_exam_items, study_exam_papers,
  study_question_versions, study_questions, study_concepts, study_space_courses, stage_meta,
  study_spaces, document_stages CASCADE`;

const BASELINE = `
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_web') THEN CREATE ROLE app_web NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_worker') THEN CREATE ROLE app_worker NOLOGIN; END IF;
END
$roles$;
CREATE SCHEMA IF NOT EXISTS app_internal;
GRANT USAGE ON SCHEMA public, app_internal TO app_web, app_worker;
CREATE OR REPLACE FUNCTION app_internal.current_owner_id()
RETURNS text LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.owner_id', true), '') $$;
GRANT EXECUTE ON FUNCTION app_internal.current_owner_id() TO app_web, app_worker;
${DROP};
CREATE TABLE document_stages (id text PRIMARY KEY, owner_id text NOT NULL);
CREATE TABLE study_spaces (
  id text PRIMARY KEY, owner_id text NOT NULL, name text NOT NULL,
  CONSTRAINT study_spaces_owner_id_key UNIQUE (owner_id, id)
);
CREATE TABLE stage_meta (stage_id text PRIMARY KEY, owner_id text NOT NULL, deleted_at timestamptz);
CREATE TABLE study_space_courses (owner_id text, space_id text, stage_id text);
GRANT SELECT ON TABLE stage_meta, study_space_courses TO app_web;
INSERT INTO study_spaces (id, owner_id, name) VALUES ('space-a', '${OWNER_A}', '高数'), ('space-b', '${OWNER_B}', '物理');
`;

type Tx = { query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }> };

interface Db {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  as(
    role: 'app_web' | 'app_worker',
    owner: string | null,
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
  web(owner: string): StudyDb;
  close(): Promise<void>;
}

function ownerBound(
  owner: string,
  transaction: <T>(body: (tx: Tx) => Promise<T>) => Promise<T>,
): StudyDb {
  const run = <T>(body: (tx: Tx) => Promise<T>) =>
    transaction(async (tx) => {
      await tx.query('SET LOCAL ROLE app_web');
      await tx.query("SELECT set_config('app.owner_id',$1,true)", [owner]);
      return body(tx);
    });
  return {
    query: (sql: string, values?: unknown[]) => run((tx) => tx.query(sql, values)),
    withTransaction: (body: (tx: Queryable) => Promise<unknown>) =>
      run((tx) => body(tx as unknown as Queryable)),
  } as unknown as StudyDb;
}

function openPglite(): Db {
  const raw = new PGlite();
  return {
    query: (sql, values) => raw.query(sql, values ?? []) as never,
    as: (role, owner, sql, values) =>
      raw.transaction(async (tx) => {
        await tx.query(`SET LOCAL ROLE ${role}`);
        if (owner) await tx.query("SELECT set_config('app.owner_id',$1,true)", [owner]);
        return (await tx.query(sql, values ?? [])) as never;
      }),
    web: (owner) =>
      ownerBound(owner, (body) =>
        raw.transaction((tx) => body({ query: (sql, values) => tx.query(sql, values ?? []) })),
      ),
    close: () => raw.close(),
  };
}

const postgresUrl = process.env.TEST_STUDY_PRACTICE_DATABASE_URL?.trim();

function openPostgres(): Db {
  const parsed = new URL(postgresUrl!);
  if (
    parsed.hostname !== '127.0.0.1' ||
    parsed.port !== '55432' ||
    !parsed.pathname.replace(/^\//, '').endsWith('_rls_proof')
  ) {
    throw new Error('TEST_STUDY_PRACTICE_DATABASE_URL must be a disposable *_rls_proof database');
  }
  const pool = new Pool({ connectionString: postgresUrl, max: 4 });
  const transaction = async <T>(body: (tx: Tx) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await body(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };
  return {
    query: (sql, values) => pool.query(sql, values),
    as: (role, owner, sql, values) =>
      transaction(async (tx) => {
        await tx.query(`SET LOCAL ROLE ${role}`);
        if (owner) await tx.query("SELECT set_config('app.owner_id',$1,true)", [owner]);
        return (await tx.query(sql, values)) as never;
      }),
    web: (owner) => ownerBound(owner, transaction),
    close: async () => {
      await pool.query(DROP);
      await pool.end();
    },
  };
}

const engines: Array<[string, () => Db]> = [['PGlite', openPglite]];
if (postgresUrl) engines.push(['PostgreSQL', openPostgres]);

async function migrated(open: () => Db): Promise<Db> {
  const db = open();
  await applySql(db, BASELINE);
  await applySql(db, ACCOUNTS_MIGRATION_28);
  await applySql(db, ACCOUNTS_MIGRATION_30);
  await applySql(db, ACCOUNTS_MIGRATION_31);
  await applySql(db, ACCOUNTS_MIGRATION_32);
  return db;
}

const REQUEST: VariantJobRequest = {
  kind: 'variant',
  wrongItemId: 'wi-1',
  questionKey: 'bank:q-1',
  targets: [{ type: 'single', count: 2 }],
  subtype: null,
  concepts: ['导数'],
  materials: [],
  spaceName: '高数',
  original: { hash: 'h', stem: '原题' },
};

describe('accounts v32 AI practice', () => {
  it('is registered with a checksum', () => {
    expect(ACCOUNTS_SCHEMA_VERSION).toBeGreaterThanOrEqual(32);
    expect(ACCOUNT_MIGRATIONS.some((migration) => migration.version === 32)).toBe(true);
    expect(accountsMigrationChecksum(32)).toMatch(/^[0-9a-f]{64}$/);
  });

  for (const [engine, open] of engines) {
    describe(engine, () => {
      it('is repeatable, forces row security and grants only app_web', async () => {
        const db = await migrated(open);
        try {
          await applySql(db, ACCOUNTS_MIGRATION_32);
          const security = await db.query(
            `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
              WHERE relname = ANY($1::text[])`,
            [[...STUDY_PRACTICE_TABLES]],
          );
          expect(security.rows).toEqual([
            { relname: 'study_practice_jobs', relrowsecurity: true, relforcerowsecurity: true },
          ]);
          const grants = await db.query(
            `SELECT grantee, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privileges
               FROM information_schema.role_table_grants
              WHERE table_name = 'study_practice_jobs'
                AND grantee IN ('app_web','app_worker','anon','authenticated','PUBLIC')
              GROUP BY grantee`,
          );
          expect(grants.rows).toEqual([
            { grantee: 'app_web', privileges: 'DELETE,INSERT,SELECT,UPDATE' },
          ]);
          await expect(
            db.as('app_worker', null, 'SELECT 1 FROM study_practice_jobs'),
          ).rejects.toThrow();
        } finally {
          await db.close();
        }
      });

      it('keeps the shape: calls within the cap, known states, bounded assistance', async () => {
        const db = await migrated(open);
        try {
          const job = (id: string, status: string, calls: number, cap: number) =>
            db.query(
              `INSERT INTO study_practice_jobs
                 (owner_id, id, space_id, kind, status, request, evidence, request_hash,
                  idempotency_key, calls, call_cap)
               VALUES ($1, $2, 'space-a', 'variant', $3, '{}', '[]', 'h', $2 || '-key', $4, $5)`,
              [OWNER_A, id, status, calls, cap],
            );
          await expect(job('pj-over', 'pending', 4, 3)).rejects.toThrow();
          await expect(job('pj-state', 'done', 0, 3)).rejects.toThrow();
          await job('pj-ok', 'stopped', 3, 3);
          await db.query(
            `INSERT INTO study_exam_papers
               (owner_id, id, space_id, title, blueprint, item_count, total_points, idempotency_key, request_hash)
             VALUES ($1, 'paper-1', 'space-a', 't', '{}', 1, 1, 'paper-1-key', 'r')`,
            [OWNER_A],
          );
          await expect(
            db.query(
              `INSERT INTO study_exam_attempts (owner_id, id, paper_id, assistance)
               VALUES ($1, 'att-x', 'paper-1', '[]')`,
              [OWNER_A],
            ),
          ).rejects.toThrow();
          await db.query(
            `INSERT INTO study_exam_attempts (owner_id, id, paper_id) VALUES ($1, 'att-1', 'paper-1')`,
            [OWNER_A],
          );
          const stored = await db.query(
            `SELECT assistance FROM study_exam_attempts WHERE id = 'att-1'`,
          );
          expect(stored.rows[0]!.assistance).toEqual({});
        } finally {
          await db.close();
        }
      });

      it('runs jobs and help under row security and cascades from the space', async () => {
        const db = await migrated(open);
        try {
          const web = db.web(OWNER_A);
          expect(
            await insertPracticeJob(web, OWNER_A, {
              id: 'pj-aaaaaaaaaaaa',
              spaceId: 'space-a',
              kind: 'variant',
              request: REQUEST,
              evidence: [{ id: 'Q0', kind: 'question', text: '原题' }],
              requestHash: 'hash-1',
              idempotencyKey: 'key-job-0001',
              callCap: 3,
            }),
          ).toBe(true);
          // The same key again inserts nothing.
          expect(
            await insertPracticeJob(web, OWNER_A, {
              id: 'pj-bbbbbbbbbbbb',
              spaceId: 'space-a',
              kind: 'variant',
              request: REQUEST,
              evidence: [],
              requestHash: 'hash-1',
              idempotencyKey: 'key-job-0001',
              callCap: 3,
            }),
          ).toBe(false);

          const claim = await claimPracticeStep(web, OWNER_A, 'pj-aaaaaaaaaaaa');
          expect(claim?.job).toMatchObject({ status: 'pending', steps: 1, calls: 0 });
          // One step at a time.
          expect(await claimPracticeStep(web, OWNER_A, 'pj-aaaaaaaaaaaa')).toBeNull();
          // Another owner sees and claims nothing.
          const other = db.web(OWNER_B);
          await expect(getPracticeJob(other, OWNER_B, 'pj-aaaaaaaaaaaa')).rejects.toMatchObject({
            code: 'STUDY_PRACTICE_JOB_NOT_FOUND',
          });
          expect(await claimPracticeStep(other, OWNER_A, 'pj-aaaaaaaaaaaa')).toBeNull();
          expect((await other.query('SELECT * FROM study_practice_jobs')).rows).toHaveLength(0);

          await web.withTransaction(async (tx) => {
            expect(await lockClaimedJob(tx, OWNER_A, 'pj-aaaaaaaaaaaa', 'wrong-token')).toBeNull();
            const locked = await lockClaimedJob(tx, OWNER_A, 'pj-aaaaaaaaaaaa', claim!.token);
            expect(locked?.id).toBe('pj-aaaaaaaaaaaa');
            await finishPracticeStep(tx, OWNER_A, 'pj-aaaaaaaaaaaa', {
              status: 'stopped',
              produced: [],
              rejected: [{ batch: 1, stage: 'output', reason: 'not_json' }],
              calls: 2,
              inputTokens: 10,
              outputTokens: 5,
              usageKnown: true,
              models: ['deepseek:deepseek-flash'],
              lastError: 'budget',
            });
          });
          const stopped = await getPracticeJob(web, OWNER_A, 'pj-aaaaaaaaaaaa');
          expect(stopped).toMatchObject({
            status: 'stopped',
            calls: 2,
            leaseToken: null,
            lastError: 'budget',
            rejected: [{ reason: 'not_json' }],
          });
          const cancelled = await setPracticeStatus(
            web,
            OWNER_A,
            'pj-aaaaaaaaaaaa',
            ['stopped'],
            'cancelled',
          );
          expect(cancelled?.status).toBe('cancelled');

          // Help is recorded only on an open practice attempt.
          await db.query(
            `INSERT INTO study_exam_papers
               (owner_id, id, space_id, title, mode, blueprint, item_count, total_points, idempotency_key, request_hash)
             VALUES ($1, 'paper-p', 'space-a', '变式练习', 'ai',
                     '{"practice":{"kind":"variant","wrongItemId":"wi-1","questionKey":"bank:q-1"}}',
                     1, 1, 'paper-p-key', 'r')`,
            [OWNER_A],
          );
          await db.query(
            `INSERT INTO study_exam_items
               (owner_id, paper_id, position, pack_question, content_hash, snapshot, answer_key)
             VALUES ($1, 'paper-p', 1, 'pack:x', 'h1',
                     '{"type":"single","stem":"题","options":[{"value":"A","label":"甲"},{"value":"B","label":"乙"}],"points":1,"hint":"想想定义"}',
                     '["A"]')`,
            [OWNER_A],
          );
          await db.query(
            `INSERT INTO study_exam_attempts (owner_id, id, paper_id, assistance)
             VALUES ($1, 'att-p', 'paper-p', '{"items":{"1":{"novelty":"new"}}}')`,
            [OWNER_A],
          );
          await recordAssistance(web, OWNER_A, 'att-p', 1, 'hint');
          const view = await getAttemptView(web, OWNER_A, 'att-p');
          expect(view.assistance).toMatchObject({
            practice: true,
            items: {
              '1': { novelty: 'new', level: 'hinted', hint: '想想定义', hintAvailable: true },
            },
          });
          await expect(
            recordAssistance(other, OWNER_B, 'att-p', 1, 'solution'),
          ).rejects.toMatchObject({
            code: 'STUDY_ATTEMPT_NOT_FOUND',
          });
          await db.query(
            `UPDATE study_exam_attempts
                SET status = 'submitted', submitted_at = now(), grading = '{}', submitted_digest = 'd',
                    earned = 0, total_points = 1
              WHERE id = 'att-p'`,
          );
          await expect(
            recordAssistance(web, OWNER_A, 'att-p', 1, 'solution'),
          ).rejects.toMatchObject({
            code: 'STUDY_ATTEMPT_SUBMITTED',
          });

          await db.query(`DELETE FROM study_spaces WHERE id = 'space-a'`);
          expect((await db.query('SELECT 1 FROM study_practice_jobs')).rows).toHaveLength(0);
        } finally {
          await db.close();
        }
      });
    });
  }
});
