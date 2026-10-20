/**
 * Accounts v33 (review tasks and Memory summaries, learning plan B12):
 * registered and repeatable; cards, settings and summaries force row
 * security and are granted to app_web owner-bound, with the worker reading
 * summaries only; the shape constraints hold; the repository derives cards
 * under row security (another owner sees nothing), keeps the student's
 * actions with a revision check, and everything cascades from its space (a
 * card also from its wrong item).
 *
 * Runs on PGlite always; set TEST_STUDY_REVIEW_DATABASE_URL to a dedicated
 * disposable *_rls_proof database on 127.0.0.1:55432 to repeat it on real
 * PostgreSQL.
 */
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { ACCOUNT_MIGRATIONS, accountsMigrationChecksum } from '@/lib/server/accounts/migrations';
import { ACCOUNTS_SCHEMA_VERSION } from '@/lib/server/accounts/sql-accounts';
import { ACCOUNTS_MIGRATION_27 } from '@/lib/server/accounts/sql-study-memory';
import { ACCOUNTS_MIGRATION_28 } from '@/lib/server/accounts/sql-study-exams';
import { ACCOUNTS_MIGRATION_30 } from '@/lib/server/accounts/sql-study-grading';
import { ACCOUNTS_MIGRATION_32 } from '@/lib/server/accounts/sql-study-practice';
import { ACCOUNTS_MIGRATION_33, STUDY_REVIEW_TABLES } from '@/lib/server/accounts/sql-study-review';
import { ACCOUNTS_MIGRATION_31 } from '@/lib/server/accounts/sql-study-wrongbook';
import { deleteSummaryRows } from '@/lib/server/study/memory/repository';
import { deleteSummary } from '@/lib/server/study/memory/summary';
import { putReviewSettings, readCardInputs } from '@/lib/server/study/review/repository';
import { applyReviewAction, refreshCards } from '@/lib/server/study/review/service';
import type { StudyDb } from '@/lib/server/study/spaces/repository';
import { REVIEW_RULE_VERSION } from '@/lib/study/review/contracts';
import { applySql } from '@/tests/helpers/model-credentials-db';
import type { Queryable } from '@openmaic/storage/document/pg';

const OWNER_A = 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_B = 'user:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const DROP = `DROP TABLE IF EXISTS study_memory_summaries, study_review_settings, study_review_cards,
  study_practice_jobs, study_wrong_occurrences, study_wrong_items, study_exam_gradings,
  study_exam_attempts, study_exam_items, study_exam_papers, study_question_versions,
  study_questions, study_concepts, study_learning_events, study_learner_preferences,
  study_memory_facts, study_memory_controls, study_memory_suppressions, study_space_courses,
  stage_meta, study_spaces, document_stages CASCADE`;

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
  exam_date date, exam_scope text, timezone text,
  CONSTRAINT study_spaces_owner_id_key UNIQUE (owner_id, id)
);
CREATE TABLE stage_meta (stage_id text PRIMARY KEY, owner_id text NOT NULL, deleted_at timestamptz);
CREATE TABLE study_space_courses (owner_id text, space_id text, stage_id text);
GRANT SELECT ON TABLE stage_meta, study_space_courses, study_spaces TO app_web;
INSERT INTO study_spaces (id, owner_id, name, timezone)
  VALUES ('space-a', '${OWNER_A}', '高数', 'Asia/Shanghai'), ('space-b', '${OWNER_B}', '物理', NULL);
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

const postgresUrl = process.env.TEST_STUDY_REVIEW_DATABASE_URL?.trim();

function openPostgres(): Db {
  const parsed = new URL(postgresUrl!);
  if (
    parsed.hostname !== '127.0.0.1' ||
    parsed.port !== '55432' ||
    !parsed.pathname.replace(/^\//, '').endsWith('_rls_proof')
  ) {
    throw new Error('TEST_STUDY_REVIEW_DATABASE_URL must be a disposable *_rls_proof database');
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
  await applySql(db, ACCOUNTS_MIGRATION_27);
  await applySql(db, ACCOUNTS_MIGRATION_28);
  await applySql(db, ACCOUNTS_MIGRATION_30);
  await applySql(db, ACCOUNTS_MIGRATION_31);
  await applySql(db, ACCOUNTS_MIGRATION_32);
  await applySql(db, ACCOUNTS_MIGRATION_33);
  return db;
}

/** A wrong item with a wrong answer two days ago (inserted as the administrator). */
async function seedItem(db: Db, owner: string, space: string, id: string) {
  await db.query(
    `INSERT INTO study_wrong_items (owner_id, id, space_id, question_key, source_type, concepts)
     VALUES ($1, $2, $3, 'bank:q-' || $2, 'exam_attempt', ARRAY['导数'])`,
    [owner, id, space],
  );
  await db.query(
    `INSERT INTO study_exam_papers
       (owner_id, id, space_id, title, blueprint, item_count, total_points, idempotency_key, request_hash)
     VALUES ($1, 'paper-' || $2, $3, 't', '{}', 1, 1, 'key-' || $2, 'r')`,
    [owner, id, space],
  );
  await db.query(
    `INSERT INTO study_exam_attempts (owner_id, id, paper_id)
     VALUES ($1, 'att-' || $2, 'paper-' || $2)`,
    [owner, id],
  );
  await db.query(
    `INSERT INTO study_wrong_occurrences
       (owner_id, item_id, source_key, attempt_id, occurred_at, outcome, earned, points, question,
        grading, origin, digest)
     VALUES ($1, $2, 'exam:att-' || $2 || ':1', 'att-' || $2, now() - interval '2 days',
             'incorrect', 0, 1, '{"type":"single","stem":"题","options":[]}', '{}', '{}', 'd1')`,
    [owner, id],
  );
}

describe('accounts v33 review tasks and Memory summaries', () => {
  it('is registered with a checksum', () => {
    expect(ACCOUNTS_SCHEMA_VERSION).toBeGreaterThanOrEqual(33);
    expect(ACCOUNT_MIGRATIONS.some((migration) => migration.version === 33)).toBe(true);
    expect(accountsMigrationChecksum(33)).toMatch(/^[0-9a-f]{64}$/);
  });

  for (const [engine, open] of engines) {
    describe(engine, () => {
      it('is repeatable, forces row security, grants app_web and lets the worker read summaries only', async () => {
        const db = await migrated(open);
        try {
          await applySql(db, ACCOUNTS_MIGRATION_33);
          const security = await db.query(
            `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
              WHERE relname = ANY($1::text[]) ORDER BY relname`,
            [[...STUDY_REVIEW_TABLES]],
          );
          expect(security.rows).toEqual(
            [...STUDY_REVIEW_TABLES].sort().map((relname) => ({
              relname,
              relrowsecurity: true,
              relforcerowsecurity: true,
            })),
          );
          const grants = await db.query(
            `SELECT table_name, grantee, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privileges
               FROM information_schema.role_table_grants
              WHERE table_name = ANY($1::text[])
                AND grantee IN ('app_web','app_worker','anon','authenticated','PUBLIC')
              GROUP BY table_name, grantee ORDER BY table_name, grantee`,
            [[...STUDY_REVIEW_TABLES]],
          );
          expect(grants.rows).toEqual([
            { table_name: 'study_memory_summaries', grantee: 'app_web', privileges: 'DELETE,INSERT,SELECT,UPDATE' },
            { table_name: 'study_memory_summaries', grantee: 'app_worker', privileges: 'SELECT' },
            { table_name: 'study_review_cards', grantee: 'app_web', privileges: 'DELETE,INSERT,SELECT,UPDATE' },
            { table_name: 'study_review_settings', grantee: 'app_web', privileges: 'DELETE,INSERT,SELECT,UPDATE' },
          ]);
          await expect(db.as('app_worker', null, 'SELECT 1 FROM study_review_cards')).rejects.toThrow();
          await db.query(
            `INSERT INTO study_memory_summaries
               (owner_id, space_id, status, text, source_watermark, input_hash, policy_version)
             VALUES ($1, 'space-a', 'ready', '最近做了导数试卷。', 3, 'h', 'p')`,
            [OWNER_A],
          );
          // The worker reads with the owner named in the query (as it does for preferences).
          const read = await db.as(
            'app_worker',
            null,
            'SELECT text FROM study_memory_summaries WHERE owner_id = $1 AND space_id = $2',
            [OWNER_A, 'space-a'],
          );
          expect(read.rows).toEqual([{ text: '最近做了导数试卷。' }]);
          await expect(
            db.as('app_worker', null, `DELETE FROM study_memory_summaries WHERE owner_id = $1`, [OWNER_A]),
          ).rejects.toThrow();
        } finally {
          await db.close();
        }
      });

      it('keeps the shape: known evidence states, text only when ready, bounded minutes', async () => {
        const db = await migrated(open);
        try {
          await seedItem(db, OWNER_A, 'space-a', 'wi-a');
          const card = (state: string) =>
            db.query(
              `INSERT INTO study_review_cards
                 (owner_id, item_id, space_id, rule_version, input_digest, card, fsrs_due_at,
                  evidence_state, evidence)
               VALUES ($1, 'wi-a', 'space-a', 'r', 'd', '{}', now(), $2, '{}')`,
              [OWNER_A, state],
            );
          await expect(card('mastered')).rejects.toThrow();
          await card('pending');
          await expect(
            db.query(
              `INSERT INTO study_memory_summaries (owner_id, space_id, status, text, input_hash, policy_version)
               VALUES ($1, 'space-a', 'failed', 'x', 'h', 'p')`,
              [OWNER_A],
            ),
          ).rejects.toThrow();
          await expect(
            db.query(
              `INSERT INTO study_memory_summaries (owner_id, space_id, status, text, input_hash, policy_version)
               VALUES ($1, 'space-a', 'ready', NULL, 'h', 'p')`,
              [OWNER_A],
            ),
          ).rejects.toThrow();
          await expect(
            db.query(
              `INSERT INTO study_review_settings (owner_id, space_id, daily_minutes) VALUES ($1, 'space-a', 2)`,
              [OWNER_A],
            ),
          ).rejects.toThrow();
        } finally {
          await db.close();
        }
      });

      it('derives cards under row security, checks revisions and cascades', async () => {
        const db = await migrated(open);
        try {
          await seedItem(db, OWNER_A, 'space-a', 'wi-a');
          await seedItem(db, OWNER_B, 'space-b', 'wi-b');
          const web = db.web(OWNER_A);
          expect(await refreshCards(web, OWNER_A, 'space-a')).toBe(1);
          // Unchanged inputs: nothing recomputed.
          expect(await refreshCards(web, OWNER_A, 'space-a')).toBe(0);
          const [input] = await readCardInputs(web, OWNER_A, 'space-a');
          expect(input!.card).toMatchObject({
            evidenceState: 'pending',
            ruleVersion: REVIEW_RULE_VERSION,
            revision: 1,
            actions: [],
          });
          // Another owner sees nothing and derives nothing for A's space.
          const other = db.web(OWNER_B);
          expect(await refreshCards(other, OWNER_B, 'space-a')).toBe(0);
          expect((await other.query('SELECT * FROM study_review_cards')).rows).toHaveLength(0);

          // An action with the right revision is kept; a stale one conflicts.
          const done = await applyReviewAction(web, OWNER_A, 'wi-a', { kind: 'done', revision: 1 });
          expect(done.revision).toBe(2);
          expect(done.actions).toEqual([{ kind: 'done', at: expect.any(String) }]);
          await expect(
            applyReviewAction(web, OWNER_A, 'wi-a', { kind: 'skip', revision: 1 }),
          ).rejects.toMatchObject({ code: 'STUDY_REVISION_CONFLICT' });
          await expect(
            applyReviewAction(web, OWNER_A, 'wi-a', { kind: 'postpone', until: '2020-01-01', revision: 2 }),
          ).rejects.toMatchObject({ code: 'STUDY_REVIEW_INVALID' });
          await expect(
            applyReviewAction(other, OWNER_B, 'wi-a', { kind: 'done', revision: 2 }),
          ).rejects.toMatchObject({ code: 'STUDY_WRONG_ITEM_NOT_FOUND' });
          // A "reviewed" mark is replayed: the stored card now has two reviews.
          const card = await db.query(`SELECT card FROM study_review_cards WHERE item_id = 'wi-a'`);
          expect((card.rows[0]!.card as { reps: number }).reps).toBe(2);
          // A new grading of the occurrence (new digest) recomputes the card.
          await db.query(`UPDATE study_wrong_occurrences SET digest = 'd2' WHERE item_id = 'wi-a'`);
          expect(await refreshCards(web, OWNER_A, 'space-a')).toBe(1);

          // Settings: create with revision 0, then a stale revision conflicts.
          const settings = await putReviewSettings(web, OWNER_A, 'space-a', 30, 0);
          expect(settings).toEqual({ dailyMinutes: 30, revision: 1, custom: true });
          await expect(putReviewSettings(web, OWNER_A, 'space-a', 45, 0)).rejects.toMatchObject({
            code: 'STUDY_REVISION_CONFLICT',
          });

          // Summaries: deleting by hand suppresses the same inputs; invalidation clears all.
          await db.query(
            `INSERT INTO study_memory_summaries
               (owner_id, space_id, status, text, input_hash, policy_version)
             VALUES ($1, 'space-a', 'ready', '最近做了导数试卷。', 'hash-1', 'p')`,
            [OWNER_A],
          );
          await deleteSummary(web, OWNER_A, 'space-a');
          const suppressed = await db.query(
            `SELECT kind, target_key FROM study_memory_suppressions WHERE owner_id = $1`,
            [OWNER_A],
          );
          expect(suppressed.rows).toEqual([{ kind: 'summary', target_key: 'space-a:hash-1' }]);
          await db.query(
            `INSERT INTO study_memory_summaries (owner_id, space_id, status, input_hash, policy_version)
             VALUES ($1, 'space-a', 'failed', 'hash-2', 'p')`,
            [OWNER_A],
          );
          await deleteSummaryRows(web, OWNER_A, null);
          expect(
            (await db.query('SELECT 1 FROM study_memory_summaries WHERE owner_id = $1', [OWNER_A])).rows,
          ).toHaveLength(0);

          // Cascade: deleting the wrong item removes its card; the space removes the rest.
          await db.query(`DELETE FROM study_wrong_items WHERE id = 'wi-a'`);
          expect((await db.query(`SELECT 1 FROM study_review_cards WHERE item_id = 'wi-a'`)).rows).toHaveLength(0);
          await db.query(
            `INSERT INTO study_memory_summaries (owner_id, space_id, status, input_hash, policy_version)
             VALUES ($1, 'space-a', 'failed', 'hash-3', 'p')`,
            [OWNER_A],
          );
          await db.query(`DELETE FROM study_spaces WHERE id = 'space-a'`);
          for (const table of STUDY_REVIEW_TABLES) {
            const left = await db.query(`SELECT 1 FROM ${table} WHERE owner_id = $1`, [OWNER_A]);
            expect(left.rows, table).toHaveLength(0);
          }
        } finally {
          await db.close();
        }
      });
    });
  }
});
