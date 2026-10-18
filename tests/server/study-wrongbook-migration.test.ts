/**
 * Accounts v31 (the wrong-answer book, learning plan B10): registered and
 * repeatable; both tables force row security and are granted only to app_web
 * (owner-bound, no worker access); the shape constraints hold; the
 * repository runs under row security — replaying a source writes nothing,
 * a right answer before any mistake is not kept, another owner sees and
 * changes nothing — and rows cascade from their attempt, space and course.
 *
 * Runs on PGlite always; set TEST_STUDY_WRONGBOOK_DATABASE_URL to a dedicated
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
  ACCOUNTS_MIGRATION_31,
  STUDY_WRONGBOOK_TABLES,
} from '@/lib/server/accounts/sql-study-wrongbook';
import type { StudyDb } from '@/lib/server/study/spaces/repository';
import {
  readItemRows,
  updateItemState,
  writeEntries,
} from '@/lib/server/study/wrongbook/repository';
import type { WrongEntry } from '@/lib/study/wrongbook/contracts';
import { applySql } from '@/tests/helpers/model-credentials-db';
import type { Queryable } from '@openmaic/storage/document/pg';

const OWNER_A = 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_B = 'user:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const DROP = `DROP TABLE IF EXISTS study_wrong_occurrences, study_wrong_items, study_exam_gradings,
  study_exam_attempts, study_exam_items, study_exam_papers, study_question_versions, study_questions,
  study_concepts, study_space_courses, stage_meta, study_spaces, document_stages CASCADE`;

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
INSERT INTO document_stages (id, owner_id) VALUES ('stage-a', '${OWNER_A}');
INSERT INTO stage_meta (stage_id, owner_id) VALUES ('stage-a', '${OWNER_A}');
INSERT INTO study_space_courses VALUES ('${OWNER_A}', 'space-a', 'stage-a');
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

const postgresUrl = process.env.TEST_STUDY_WRONGBOOK_DATABASE_URL?.trim();

function openPostgres(): Db {
  const parsed = new URL(postgresUrl!);
  if (
    parsed.hostname !== '127.0.0.1' ||
    parsed.port !== '55432' ||
    !parsed.pathname.replace(/^\//, '').endsWith('_rls_proof')
  ) {
    throw new Error('TEST_STUDY_WRONGBOOK_DATABASE_URL must be a disposable *_rls_proof database');
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
  return db;
}

function quizEntry(
  question: string,
  outcome: WrongEntry['outcome'],
  occurredAt: string,
  session: string,
): WrongEntry {
  return {
    questionKey: `quiz:stage-a:quiz:${question}`,
    sourceType: 'quiz_attempt',
    sourceKey: `quiz:${session}:${question}`,
    stageId: 'stage-a',
    attemptId: null,
    occurredAt,
    outcome,
    earned: outcome === 'correct' ? 1 : 0,
    points: 1,
    question: { type: 'single', stem: question, options: [], answer: ['A'], concepts: ['导数'] },
    response: { choices: [outcome === 'correct' ? 'A' : 'B'] },
    grading: { by: 'classroom', method: 'answer_key', version: 'quiz-grading-v1' },
    origin: { stageId: 'stage-a', sceneId: 'quiz' },
  };
}

describe('accounts v31 wrong-answer book', () => {
  it('is registered with a checksum', () => {
    expect(ACCOUNTS_SCHEMA_VERSION).toBeGreaterThanOrEqual(31);
    expect(ACCOUNT_MIGRATIONS.some((migration) => migration.version === 31)).toBe(true);
    expect(accountsMigrationChecksum(31)).toMatch(/^[0-9a-f]{64}$/);
  });

  for (const [engine, open] of engines) {
    describe(engine, () => {
      it('is repeatable, forces row security and grants only app_web', async () => {
        const db = await migrated(open);
        try {
          await applySql(db, ACCOUNTS_MIGRATION_31);
          const security = await db.query(
            `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
              WHERE relname = ANY($1::text[]) ORDER BY relname`,
            [[...STUDY_WRONGBOOK_TABLES]],
          );
          expect(security.rows).toEqual([
            { relname: 'study_wrong_items', relrowsecurity: true, relforcerowsecurity: true },
            { relname: 'study_wrong_occurrences', relrowsecurity: true, relforcerowsecurity: true },
          ]);
          const grants = await db.query(
            `SELECT table_name, grantee, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privileges
               FROM information_schema.role_table_grants
              WHERE table_name = ANY($1::text[]) AND grantee IN ('app_web','app_worker','anon','authenticated','PUBLIC')
              GROUP BY table_name, grantee ORDER BY table_name, grantee`,
            [[...STUDY_WRONGBOOK_TABLES]],
          );
          expect(grants.rows).toEqual([
            {
              table_name: 'study_wrong_items',
              grantee: 'app_web',
              privileges: 'DELETE,INSERT,SELECT,UPDATE',
            },
            {
              table_name: 'study_wrong_occurrences',
              grantee: 'app_web',
              privileges: 'DELETE,INSERT,SELECT,UPDATE',
            },
          ]);
          await expect(
            db.as('app_worker', null, 'SELECT 1 FROM study_wrong_items'),
          ).rejects.toThrow();
        } finally {
          await db.close();
        }
      });

      it('keeps the shape: course items name a course, outcomes and points are valid', async () => {
        const db = await migrated(open);
        try {
          const item = (id: string, source: string, stage: string | null) =>
            db.query(
              `INSERT INTO study_wrong_items (owner_id, id, space_id, question_key, source_type, stage_id)
               VALUES ($1, $2, 'space-a', $2, $3, $4)`,
              [OWNER_A, id, source, stage],
            );
          await expect(item('wi-exam-stage', 'exam_attempt', 'stage-a')).rejects.toThrow();
          await expect(item('wi-quiz-none', 'quiz_attempt', null)).rejects.toThrow();
          await item('wi-ok', 'quiz_attempt', 'stage-a');
          const occurrence = (outcome: string, earned: number, points: number) =>
            db.query(
              `INSERT INTO study_wrong_occurrences
                 (owner_id, item_id, source_key, occurred_at, outcome, earned, points, question, grading, origin, digest)
               VALUES ($1, 'wi-ok', $2, now(), $3, $4, $5, '{}', '{}', '{}', 'd')`,
              [OWNER_A, `k-${outcome}-${earned}-${points}`, outcome, earned, points],
            );
          await expect(occurrence('wrongish', 0, 1)).rejects.toThrow();
          await expect(occurrence('incorrect', 2, 1)).rejects.toThrow();
          await expect(occurrence('incorrect', 0, 0)).rejects.toThrow();
          await occurrence('partial', 0.5, 1);
        } finally {
          await db.close();
        }
      });

      it('runs the repository under row security and cascades from its sources', async () => {
        const db = await migrated(open);
        try {
          const web = db.web(OWNER_A);
          const entries = [
            // Right before any mistake: not kept.
            quizEntry('q1', 'correct', '2026-10-01T00:00:00.000Z', 's0'),
            quizEntry('q1', 'incorrect', '2026-10-02T00:00:00.000Z', 's1'),
            quizEntry('q1', 'correct', '2026-10-03T00:00:00.000Z', 's2'),
            quizEntry('q2', 'correct', '2026-10-03T00:00:00.000Z', 's2'),
          ];
          const first = await web.withTransaction((tx) =>
            writeEntries(tx, OWNER_A, 'space-a', entries),
          );
          expect(first).toEqual({ written: 2, full: false });
          expect(
            await web.withTransaction((tx) => writeEntries(tx, OWNER_A, 'space-a', entries)),
          ).toEqual({
            written: 0,
            full: false,
          });
          const rows = await readItemRows(web, OWNER_A, 'space-a');
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({
            wrongCount: 1,
            attemptCount: 2,
            concepts: ['导数'],
            sourceType: 'quiz_attempt',
          });

          // Another owner sees nothing and changes nothing.
          const other = db.web(OWNER_B);
          expect((await other.query('SELECT * FROM study_wrong_items')).rows).toHaveLength(0);
          expect((await other.query('SELECT * FROM study_wrong_occurrences')).rows).toHaveLength(0);
          await expect(
            updateItemState(other, OWNER_B, rows[0]!.id, 1, { archived: true }),
          ).rejects.toMatchObject({
            code: 'STUDY_WRONG_ITEM_NOT_FOUND',
          });
          await expect(
            other.query(
              `INSERT INTO study_wrong_items (owner_id, id, space_id, question_key, source_type, stage_id)
               VALUES ($1, 'wi-forged', 'space-a', 'x', 'quiz_attempt', 'stage-a')`,
              [OWNER_A],
            ),
          ).rejects.toThrow();
          expect(
            await updateItemState(web, OWNER_A, rows[0]!.id, 1, { reviewState: 'to_review' }),
          ).toEqual({
            revision: 2,
            reviewState: 'to_review',
            archived: false,
          });

          // A paper occurrence goes with its attempt.
          await db.query(
            `INSERT INTO study_exam_papers
               (owner_id, id, space_id, title, blueprint, item_count, total_points, idempotency_key, request_hash)
             VALUES ($1, 'paper-1', 'space-a', 't', '{}', 1, 2, 'paper-1-key', 'r')`,
            [OWNER_A],
          );
          await db.query(
            `INSERT INTO study_exam_attempts (owner_id, id, paper_id) VALUES ($1, 'att-1', 'paper-1')`,
            [OWNER_A],
          );
          const exam: WrongEntry = {
            ...quizEntry('e1', 'incorrect', '2026-10-04T00:00:00.000Z', 'x'),
            questionKey: 'bank:q-1',
            sourceType: 'exam_attempt',
            sourceKey: 'exam:att-1:1',
            stageId: null,
            attemptId: 'att-1',
          };
          await web.withTransaction((tx) => writeEntries(tx, OWNER_A, 'space-a', [exam]));
          expect(await readItemRows(web, OWNER_A, 'space-a')).toHaveLength(2);
          await db.query(`DELETE FROM study_exam_attempts WHERE id = 'att-1'`);
          expect(
            (await db.query(`SELECT 1 FROM study_wrong_occurrences WHERE attempt_id = 'att-1'`))
              .rows,
          ).toHaveLength(0);
          expect(await readItemRows(web, OWNER_A, 'space-a')).toHaveLength(1);

          // A deleted course takes its items along; a deleted space takes the rest.
          await db.query(`DELETE FROM document_stages WHERE id = 'stage-a'`);
          expect(
            (await db.query(`SELECT 1 FROM study_wrong_items WHERE stage_id IS NOT NULL`)).rows,
          ).toHaveLength(0);
          await db.query(`DELETE FROM study_spaces WHERE id = 'space-a'`);
          expect((await db.query(`SELECT 1 FROM study_wrong_items`)).rows).toHaveLength(0);
        } finally {
          await db.close();
        }
      });
    });
  }
});
