/**
 * Accounts v28 (question bank, papers and attempts, learning plan B07):
 * repeatable, forces row security on all six tables, grants nothing to the
 * Data API roles, isolates owners under app_web, keeps question versions and
 * paper items immutable, never lets a submitted attempt change, allows one
 * open attempt per paper, and gives the worker no access.
 *
 * Runs on PGlite always; set TEST_STUDY_EXAMS_DATABASE_URL to a dedicated
 * disposable *_rls_proof database on 127.0.0.1:55432 to repeat it on real
 * PostgreSQL, including two concurrent submits on separate connections.
 */
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { accountsMigrationChecksum } from '@/lib/server/accounts/migrations';
import { ACCOUNTS_SCHEMA_VERSION } from '@/lib/server/accounts/sql-accounts';
import { ACCOUNTS_MIGRATION_28, STUDY_EXAM_TABLES } from '@/lib/server/accounts/sql-study-exams';
import {
  getAttemptView,
  openAttempt,
  saveDraftAnswers,
  submitAttempt,
} from '@/lib/server/study/exams/repository';
import type { StudyDb } from '@/lib/server/study/spaces/repository';
import {
  gradeAttempt,
  type AttemptAnswers,
  type PaperItemKey,
  type PaperItemView,
} from '@/lib/study/assessments/contracts';
import { applySql } from '@/tests/helpers/model-credentials-db';
import type { Queryable } from '@openmaic/storage/document/pg';

const OWNER_A = 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_B = 'user:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const DROP = `DROP TABLE IF EXISTS study_exam_attempts, study_exam_items, study_exam_papers,
  study_question_versions, study_questions, study_concepts, study_spaces, document_stages CASCADE`;

/** What v1–v27 leave behind that v28 relies on (minimal shapes). */
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
INSERT INTO study_spaces (id, owner_id, name) VALUES ('space-a', '${OWNER_A}', '高数'), ('space-b', '${OWNER_B}', '物理');
`;

interface Db {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  as(
    role: 'app_web' | 'app_worker',
    owner: string | null,
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
  /** Two transactions on separate connections at once (real PostgreSQL only). */
  concurrently?: (
    owner: string,
    statements: [string, unknown[]][],
  ) => Promise<Array<{ rows: Record<string, unknown>[] }>>;
  /** The repository's database as web sees it: app_web, owner-bound, row security on. */
  web(owner: string): StudyDb;
  close(): Promise<void>;
}

type Tx = { query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }> };

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

const postgresUrl = process.env.TEST_STUDY_EXAMS_DATABASE_URL?.trim();

function openPostgres(): Db {
  const parsed = new URL(postgresUrl!);
  if (
    parsed.hostname !== '127.0.0.1' ||
    parsed.port !== '55432' ||
    !parsed.pathname.replace(/^\//, '').endsWith('_rls_proof')
  ) {
    throw new Error('TEST_STUDY_EXAMS_DATABASE_URL must be a disposable *_rls_proof database');
  }
  const pool = new Pool({ connectionString: postgresUrl, max: 3 });
  const as: Db['as'] = async (role, owner, sql, values) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${role}`);
      if (owner) await client.query("SELECT set_config('app.owner_id',$1,true)", [owner]);
      const result = await client.query(sql, values);
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
    as,
    web: (owner) =>
      ownerBound(owner, async (body) => {
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
      }),
    concurrently: (owner, statements) =>
      Promise.all(statements.map(([sql, values]) => as('app_web', owner, sql, values))),
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
  return db;
}

const QUESTION = `INSERT INTO study_questions (owner_id, id, space_id, origin, source_fingerprint)
  VALUES ($1, $2, $3, 'user_import', $2)`;
const VERSION = `INSERT INTO study_question_versions
  (owner_id, question_id, version, qtype, stem, options, answer, verification, gradable, content_hash)
  VALUES ($1, $2, $3, 'single', 's', '[{"value":"A","label":"x"},{"value":"B","label":"y"}]',
          '["A"]', 'user_verified', true, 'h')`;
const PAPER = `INSERT INTO study_exam_papers
  (owner_id, id, space_id, title, blueprint, item_count, total_points, idempotency_key, request_hash)
  VALUES ($1, $2, $3, 't', '{}', 1, 1, $2 || '-key', 'r')`;
const ITEM = `INSERT INTO study_exam_items
  (owner_id, paper_id, position, question_id, question_version, content_hash, snapshot, answer_key)
  VALUES ($1, $2, 1, 'q-1', 1, 'h', '{}', '["A"]')`;
const ATTEMPT = `INSERT INTO study_exam_attempts (owner_id, id, paper_id) VALUES ($1, $2, $3)`;
const SUBMIT = `UPDATE study_exam_attempts
  SET status = 'submitted', submitted_at = now(), grading = $3::jsonb, submitted_digest = 'd',
      earned = $4, total_points = 1, submit_key = $5
  WHERE owner_id = $1 AND id = $2 AND status = 'in_progress' RETURNING id`;

describe('accounts v28 registration', () => {
  it('is the newest accounts version with a stable checksum', () => {
    expect(ACCOUNTS_SCHEMA_VERSION).toBe(28);
    expect(accountsMigrationChecksum(28)).toMatch(/^[a-f0-9]{64}$/);
    expect(ACCOUNTS_MIGRATION_28).toContain('FORCE ROW LEVEL SECURITY');
  });
});

describe.each(engines)('accounts v28 question bank and papers (%s)', (_name, open) => {
  it('applies twice, forces row security and grants nothing to Data API roles', async () => {
    const db = await migrated(open);
    try {
      await applySql(db, ACCOUNTS_MIGRATION_28);
      const flags = await db.query(
        `SELECT relname FROM pg_class WHERE relname = ANY($1::text[])
           AND relrowsecurity AND relforcerowsecurity ORDER BY relname`,
        [[...STUDY_EXAM_TABLES]],
      );
      expect(flags.rows.map((row) => row.relname)).toEqual([...STUDY_EXAM_TABLES].sort());
      const grants = await db.query(
        `SELECT table_name, grantee FROM information_schema.role_table_grants
          WHERE table_name = ANY($1::text[])
            AND grantee IN ('anon', 'authenticated', 'PUBLIC', 'app_worker')`,
        [[...STUDY_EXAM_TABLES]],
      );
      expect(grants.rows).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('isolates owners and keeps versions and paper items immutable', async () => {
    const db = await migrated(open);
    try {
      await db.as('app_web', OWNER_A, QUESTION, [OWNER_A, 'q-1', 'space-a']);
      await db.as('app_web', OWNER_A, VERSION, [OWNER_A, 'q-1', 1]);
      await db.as('app_web', OWNER_B, QUESTION, [OWNER_B, 'q-b', 'space-b']);
      // Same fingerprint in the same space: refused by the unique key.
      await expect(
        db.as('app_web', OWNER_A, QUESTION, [OWNER_A, 'q-1', 'space-a']),
      ).rejects.toThrow();
      // Another owner's space, or a row for another owner: refused.
      await expect(
        db.as('app_web', OWNER_A, QUESTION, [OWNER_A, 'q-x', 'space-b']),
      ).rejects.toThrow();
      await expect(
        db.as('app_web', OWNER_A, QUESTION, [OWNER_B, 'q-y', 'space-b']),
      ).rejects.toThrow();
      // A version of another owner's question cannot be added.
      await expect(db.as('app_web', OWNER_A, VERSION, [OWNER_A, 'q-b', 1])).rejects.toThrow();
      await expect(
        db.as('app_web', OWNER_A, `UPDATE study_question_versions SET stem = 'changed'`),
      ).rejects.toThrow();

      await db.as('app_web', OWNER_A, PAPER, [OWNER_A, 'paper-1', 'space-a']);
      await db.as('app_web', OWNER_A, ITEM, [OWNER_A, 'paper-1']);
      await expect(
        db.as('app_web', OWNER_A, `UPDATE study_exam_items SET answer_key = '["B"]'`),
      ).rejects.toThrow();
      await expect(
        db.as('app_web', OWNER_A, `UPDATE study_exam_papers SET title = 'x'`),
      ).rejects.toThrow();

      for (const table of STUDY_EXAM_TABLES) {
        const rows = await db.as('app_web', OWNER_B, `SELECT owner_id FROM ${table}`);
        expect(
          rows.rows.every((row) => row.owner_id === OWNER_B),
          table,
        ).toBe(true);
      }
      // Another owner cannot delete what it cannot see.
      const none = await db.as('app_web', OWNER_B, `DELETE FROM study_questions RETURNING id`);
      expect(none.rows).toEqual([{ id: 'q-b' }]);
      expect(
        (await db.query(`SELECT id FROM study_questions WHERE owner_id = $1`, [OWNER_A])).rows,
      ).toEqual([{ id: 'q-1' }]);
      // Deleting a question removes its versions; the paper keeps its item.
      await db.as('app_web', OWNER_A, `DELETE FROM study_questions WHERE id = 'q-1'`);
      expect(
        (await db.query('SELECT count(*)::int AS n FROM study_question_versions')).rows,
      ).toEqual([{ n: 0 }]);
      expect((await db.query('SELECT count(*)::int AS n FROM study_exam_items')).rows).toEqual([
        { n: 1 },
      ]);
      await expect(db.as('app_worker', null, 'SELECT * FROM study_exam_items')).rejects.toThrow();
    } finally {
      await db.close();
    }
  });

  it('keeps one open attempt per paper and never changes a submitted one', async () => {
    const db = await migrated(open);
    try {
      await db.as('app_web', OWNER_A, PAPER, [OWNER_A, 'paper-1', 'space-a']);
      await db.as('app_web', OWNER_A, ATTEMPT, [OWNER_A, 'att-1', 'paper-1']);
      await expect(
        db.as('app_web', OWNER_A, ATTEMPT, [OWNER_A, 'att-2', 'paper-1']),
      ).rejects.toThrow();
      // A submitted attempt needs its grading, digest and totals.
      await expect(
        db.as(
          'app_web',
          OWNER_A,
          `UPDATE study_exam_attempts SET status = 'submitted' WHERE id = 'att-1'`,
        ),
      ).rejects.toThrow();
      const submitted = await db.as('app_web', OWNER_A, SUBMIT, [
        OWNER_A,
        'att-1',
        '{"earned":1}',
        1,
        'submit-1',
      ]);
      expect(submitted.rows).toEqual([{ id: 'att-1' }]);
      // The update policy only matches open attempts: a later change touches nothing.
      const changed = await db.as(
        'app_web',
        OWNER_A,
        `UPDATE study_exam_attempts SET earned = 0 WHERE id = 'att-1' RETURNING id`,
      );
      expect(changed.rows).toEqual([]);
      expect(
        (await db.query(`SELECT earned FROM study_exam_attempts WHERE id = 'att-1'`)).rows,
      ).toEqual([{ earned: 1 }]);
      // Once submitted, a new open attempt may start.
      await db.as('app_web', OWNER_A, ATTEMPT, [OWNER_A, 'att-2', 'paper-1']);
      const hidden = await db.as('app_web', OWNER_B, 'SELECT id FROM study_exam_attempts');
      expect(hidden.rows).toEqual([]);

      if (db.concurrently) {
        // Two devices submit at the same moment: exactly one update wins.
        const results = await db.concurrently(OWNER_A, [
          [SUBMIT, [OWNER_A, 'att-2', '{"earned":1}', 1, 'submit-a']],
          [SUBMIT, [OWNER_A, 'att-2', '{"earned":0}', 0, 'submit-b']],
        ]);
        expect(results.map((result) => result.rows.length).sort()).toEqual([0, 1]);
        const stored = await db.query(
          `SELECT count(*)::int AS n FROM study_exam_attempts WHERE id = 'att-2' AND status = 'submitted'`,
        );
        expect(stored.rows).toEqual([{ n: 1 }]);
      }
    } finally {
      await db.close();
    }
  });

  it('runs the attempt repository under row security: drafts, one submit, then read-only', async () => {
    const db = await migrated(open);
    try {
      await db.query(PAPER, [OWNER_A, 'paper-1', 'space-a']);
      await db.query(
        `INSERT INTO study_exam_items
           (owner_id, paper_id, position, question_id, question_version, content_hash, snapshot, answer_key)
         VALUES ($1, 'paper-1', 1, 'q-1', 1, 'h',
           '{"type":"single","stem":"s","options":[{"value":"A","label":"x"},{"value":"B","label":"y"}],"points":2}',
           '["A"]')`,
        [OWNER_A],
      );
      const web = db.web(OWNER_A);
      const opened = await openAttempt(web, OWNER_A, 'paper-1');
      expect(opened.created).toBe(true);
      expect((await openAttempt(web, OWNER_A, 'paper-1')).id).toBe(opened.id);
      const saved = await saveDraftAnswers(web, OWNER_A, opened.id, { '1': ['B'] }, 1);
      await expect(saveDraftAnswers(web, OWNER_A, opened.id, {}, 1)).rejects.toMatchObject({
        code: 'STUDY_REVISION_CONFLICT',
        details: { revision: saved.revision, answers: { '1': ['B'] } },
      });
      const grader = (items: Array<PaperItemView & PaperItemKey>, answers: AttemptAnswers) => ({
        answers,
        grading: gradeAttempt(
          items.map((item) => ({ ...item, key: item.answer })),
          answers,
        ),
        digest: 'd',
      });
      expect(
        await submitAttempt(
          web,
          OWNER_A,
          opened.id,
          { answers: { '1': ['A'] }, baseRevision: saved.revision, submitKey: 'submit-aaaa' },
          grader,
        ),
      ).toEqual({ kind: 'submitted' });
      // Once submitted, the locking read no longer matches (update policy), yet a
      // repeat is recognised and drafts are refused instead of "not found".
      expect(
        await submitAttempt(
          web,
          OWNER_A,
          opened.id,
          { answers: null, baseRevision: null, submitKey: 'submit-aaaa' },
          grader,
        ),
      ).toEqual({ kind: 'already', sameKey: true });
      expect(
        await submitAttempt(
          web,
          OWNER_A,
          opened.id,
          { answers: null, baseRevision: null, submitKey: 'submit-bbbb' },
          grader,
        ),
      ).toEqual({ kind: 'already', sameKey: false });
      await expect(
        saveDraftAnswers(web, OWNER_A, opened.id, {}, saved.revision + 1),
      ).rejects.toMatchObject({ code: 'STUDY_ATTEMPT_SUBMITTED' });
      const view = await getAttemptView(web, OWNER_A, opened.id);
      expect(view.report?.grading).toMatchObject({ earned: 2, totalPoints: 2, correct: 1 });
      // Another owner sees nothing.
      await expect(getAttemptView(db.web(OWNER_B), OWNER_B, opened.id)).rejects.toMatchObject({
        code: 'STUDY_ATTEMPT_NOT_FOUND',
      });
    } finally {
      await db.close();
    }
  });
});
