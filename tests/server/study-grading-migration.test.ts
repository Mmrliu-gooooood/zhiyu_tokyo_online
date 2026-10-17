/**
 * Accounts v30 (open questions and assisted grading, learning plan B09):
 * repeatable, forces row security on the gradings table, grants it only to
 * app_web (no delete), keeps a finished grading unchangeable, ties open
 * subtypes and guides to open questions, accepts larger answer sets, and runs
 * the attempt and grading repositories under row security: submitting
 * creates one waiting grading per answered open item, a grading is claimed
 * once (also by two requests at the same moment), and reviews and self
 * scores add rows instead of changing earlier ones.
 *
 * Runs on PGlite always; set TEST_STUDY_GRADING_DATABASE_URL to a dedicated
 * disposable *_rls_proof database on 127.0.0.1:55432 to repeat it on real
 * PostgreSQL, including two concurrent claims on separate connections.
 */
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { accountsMigrationChecksum } from '@/lib/server/accounts/migrations';
import { ACCOUNTS_SCHEMA_VERSION } from '@/lib/server/accounts/sql-accounts';
import { ACCOUNTS_MIGRATION_28 } from '@/lib/server/accounts/sql-study-exams';
import {
  ACCOUNTS_MIGRATION_30,
  STUDY_GRADING_TABLES,
} from '@/lib/server/accounts/sql-study-grading';
import { getAttemptView, openAttempt, submitAttempt } from '@/lib/server/study/exams/repository';
import {
  addReview,
  addSelfGrade,
  claimGrading,
  finishGrading,
  listAttemptGradings,
} from '@/lib/server/study/grading/repository';
import type { StudyDb } from '@/lib/server/study/spaces/repository';
import {
  gradeAttempt,
  parseAnswers,
  type AttemptAnswers,
  type PaperItemKey,
  type PaperItemView,
} from '@/lib/study/assessments/contracts';
import { applySql } from '@/tests/helpers/model-credentials-db';
import type { Queryable } from '@openmaic/storage/document/pg';

const OWNER_A = 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_B = 'user:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const DROP = `DROP TABLE IF EXISTS study_exam_gradings, study_exam_attempts, study_exam_items,
  study_exam_papers, study_question_versions, study_questions, study_concepts, study_spaces,
  document_stages CASCADE`;

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
  /** Each body in its own transaction on its own connection (real PostgreSQL only). */
  parallel?: <T>(owner: string, bodies: Array<(db: StudyDb) => Promise<T>>) => Promise<T[]>;
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

const postgresUrl = process.env.TEST_STUDY_GRADING_DATABASE_URL?.trim();

function openPostgres(): Db {
  const parsed = new URL(postgresUrl!);
  if (
    parsed.hostname !== '127.0.0.1' ||
    parsed.port !== '55432' ||
    !parsed.pathname.replace(/^\//, '').endsWith('_rls_proof')
  ) {
    throw new Error('TEST_STUDY_GRADING_DATABASE_URL must be a disposable *_rls_proof database');
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
    parallel: (owner, bodies) =>
      Promise.all(bodies.map((body) => body(ownerBound(owner, transaction)))),
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
  return db;
}

const OPEN_GUIDE = {
  referenceAnswer: 'r',
  finalAnswer: null,
  rubric: [{ id: 'overall', text: '', points: 4 }],
};

/** A paper with one choice item and two open items. */
async function seedPaper(db: Db, owner: string, space: string, paperId: string) {
  await db.query(
    `INSERT INTO study_exam_papers
       (owner_id, id, space_id, title, blueprint, item_count, total_points, idempotency_key, request_hash)
     VALUES ($1, $2, $3, 't', '{}', 3, 9, $2 || '-key', 'r')`,
    [owner, paperId, space],
  );
  await db.query(
    `INSERT INTO study_exam_items
       (owner_id, paper_id, position, pack_question, content_hash, snapshot, answer_key, guide)
     VALUES
       ($1, $2, 1, 'pack:p@1/a', 'h1',
        '{"type":"single","stem":"s","options":[{"value":"A","label":"x"},{"value":"B","label":"y"}],"points":1}',
        '["A"]', NULL),
       ($1, $2, 2, 'pack:p@1/b', 'h2', '{"type":"short_answer","subtype":"short","stem":"o","options":[],"points":4}',
        '[]', $3::jsonb),
       ($1, $2, 3, 'pack:p@1/c', 'h3', '{"type":"short_answer","subtype":"proof","stem":"p","options":[],"points":4}',
        '[]', $3::jsonb)`,
    [owner, paperId, JSON.stringify(OPEN_GUIDE)],
  );
}

const grader = (items: Array<PaperItemView & PaperItemKey>, answers: AttemptAnswers) => {
  const valid = parseAnswers(answers, items)!;
  return {
    answers: valid,
    grading: gradeAttempt(
      items.map((item) => ({ ...item, key: item.answer })),
      valid,
    ),
    digest: 'd',
  };
};

const usage = { calls: 1, inputTokens: 10, outputTokens: 5, known: true };
const result = {
  criteria: [{ id: 'overall', awarded: 3, points: 4, by: 'model' as const, comment: 'c' }],
  feedback: 'f',
  shortcomings: [],
  finalCheck: null,
};
const graderInfo = { version: 'rubric-v1', model: 'test:model', program: null };

describe('accounts v30 registration', () => {
  it('is registered with a stable checksum', () => {
    expect(ACCOUNTS_SCHEMA_VERSION).toBeGreaterThanOrEqual(30);
    expect(accountsMigrationChecksum(30)).toMatch(/^[a-f0-9]{64}$/);
    expect(ACCOUNTS_MIGRATION_30).toContain('FORCE ROW LEVEL SECURITY');
  });
});

describe.each(engines)('accounts v30 open questions and gradings (%s)', (_name, open) => {
  it('applies twice, forces row security and grants only app_web without delete', async () => {
    const db = await migrated(open);
    try {
      await applySql(db, ACCOUNTS_MIGRATION_30);
      const flags = await db.query(
        `SELECT relname FROM pg_class WHERE relname = ANY($1::text[])
           AND relrowsecurity AND relforcerowsecurity`,
        [[...STUDY_GRADING_TABLES]],
      );
      expect(flags.rows.map((row) => row.relname)).toEqual([...STUDY_GRADING_TABLES]);
      const grants = await db.query(
        `SELECT grantee, privilege_type FROM information_schema.role_table_grants
          WHERE table_name = 'study_exam_gradings'
            AND grantee IN ('anon', 'authenticated', 'PUBLIC', 'app_worker', 'app_web')
          ORDER BY grantee, privilege_type`,
      );
      expect(grants.rows).toEqual([
        { grantee: 'app_web', privilege_type: 'INSERT' },
        { grantee: 'app_web', privilege_type: 'SELECT' },
        { grantee: 'app_web', privilege_type: 'UPDATE' },
      ]);
    } finally {
      await db.close();
    }
  });

  it('ties subtypes and guides to open questions and accepts larger answer sets', async () => {
    const db = await migrated(open);
    try {
      await db.query(
        `INSERT INTO study_questions (owner_id, id, space_id, origin, source_fingerprint)
         VALUES ($1, 'q-1', 'space-a', 'manual', 'f')`,
        [OWNER_A],
      );
      const version = (n: number, qtype: string, subtype: string | null, guide: unknown) =>
        db.as(
          'app_web',
          OWNER_A,
          `INSERT INTO study_question_versions
             (owner_id, question_id, version, qtype, stem, options, answer, verification, gradable,
              content_hash, subtype, guide)
           VALUES ($1, 'q-1', $2, $3, 's', '[]', '[]', 'unverified', false, 'h', $4, $5::jsonb)`,
          [OWNER_A, n, qtype, subtype, guide === null ? null : JSON.stringify(guide)],
        );
      await version(1, 'short_answer', 'calculation', OPEN_GUIDE);
      await version(2, 'single', null, null);
      await expect(version(3, 'short_answer', null, OPEN_GUIDE)).rejects.toThrow();
      await expect(version(4, 'single', 'short', null)).rejects.toThrow();
      await expect(version(5, 'single', null, OPEN_GUIDE)).rejects.toThrow();
      await expect(version(6, 'short_answer', 'essay', null)).rejects.toThrow();

      await seedPaper(db, OWNER_A, 'space-a', 'paper-1');
      await db.query(
        `INSERT INTO study_exam_attempts (owner_id, id, paper_id) VALUES ($1, 'att-x', 'paper-1')`,
        [OWNER_A],
      );
      const answers = (text: string) =>
        db.as(
          'app_web',
          OWNER_A,
          `UPDATE study_exam_attempts SET answers = $1::jsonb WHERE id = 'att-x' RETURNING id`,
          [JSON.stringify({ '2': { text } })],
        );
      await answers('中'.repeat(15_000));
      await expect(answers('中'.repeat(45_000))).rejects.toThrow();
    } finally {
      await db.close();
    }
  });

  it('runs submission and grading under row security', async () => {
    const db = await migrated(open);
    try {
      await seedPaper(db, OWNER_A, 'space-a', 'paper-1');
      const web = db.web(OWNER_A);
      const attempt = await openAttempt(web, OWNER_A, 'paper-1');
      expect(
        await submitAttempt(
          web,
          OWNER_A,
          attempt.id,
          {
            answers: { '1': ['A'], '2': { text: '因为……所以……' } },
            baseRevision: 1,
            submitKey: 'submit-aaaa',
          },
          grader,
        ),
      ).toEqual({ kind: 'submitted' });
      // One waiting grading for the answered open item; the blank one has none.
      let gradings = await listAttemptGradings(web, OWNER_A, attempt.id);
      expect([...gradings.keys()]).toEqual([2]);
      expect(gradings.get(2)).toMatchObject([
        { seq: 1, kind: 'auto', status: 'pending', points: 4 },
      ]);
      let view = await getAttemptView(web, OWNER_A, attempt.id);
      expect(view.report?.summary).toMatchObject({
        earned: 1,
        totalPoints: 9,
        pending: 1,
        state: 'grading',
      });
      expect(view.report?.items[1]).toMatchObject({
        type: 'short_answer',
        openResponse: { text: '因为……所以……' },
        outcome: 'pending',
        guide: OPEN_GUIDE,
      });

      // Claimed once: a second claim (or a claim racing it) finds nothing.
      let claims;
      if (db.parallel) {
        claims = await db.parallel(OWNER_A, [
          (other) => claimGrading(other, OWNER_A, attempt.id, null),
          (other) => claimGrading(other, OWNER_A, attempt.id, null),
        ]);
      } else {
        claims = [
          await claimGrading(web, OWNER_A, attempt.id, null),
          await claimGrading(web, OWNER_A, attempt.id, null),
        ];
      }
      const claim = claims.find(Boolean)!;
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect(claim).toMatchObject({ position: 2, seq: 1, tries: 1 });
      // Another owner can neither see nor claim it.
      expect(await claimGrading(db.web(OWNER_B), OWNER_B, attempt.id, null)).toBeNull();
      expect(await listAttemptGradings(db.web(OWNER_B), OWNER_B, attempt.id)).toEqual(new Map());

      // Failed: retried only when named.
      expect(
        await finishGrading(web, OWNER_A, attempt.id, claim, {
          status: 'failed',
          error: 'timeout',
          grader: graderInfo,
          usage,
        }),
      ).toBe(true);
      expect(await claimGrading(web, OWNER_A, attempt.id, null)).toBeNull();
      const retry = (await claimGrading(web, OWNER_A, attempt.id, 2))!;
      expect(retry).toMatchObject({ seq: 1, tries: 2 });
      // While its lease runs nobody else takes it; once the request died and
      // the lease ran out, the next request does.
      expect(await claimGrading(web, OWNER_A, attempt.id, null)).toBeNull();
      await db.query(
        `UPDATE study_exam_gradings SET lease_until = now() - interval '1 second'
          WHERE attempt_id = $1 AND position = 2`,
        [attempt.id],
      );
      const takeover = (await claimGrading(web, OWNER_A, attempt.id, null))!;
      expect(takeover).toMatchObject({ seq: 1, tries: 3 });
      // Stale claims cannot finish it any more.
      for (const stale of [claim, retry]) {
        expect(
          await finishGrading(web, OWNER_A, attempt.id, stale, {
            status: 'succeeded',
            earned: 4,
            result,
            grader: graderInfo,
            usage,
          }),
        ).toBe(false);
      }
      expect(
        await finishGrading(web, OWNER_A, attempt.id, takeover, {
          status: 'succeeded',
          earned: 3,
          result,
          grader: graderInfo,
          usage,
        }),
      ).toBe(true);
      // A finished grading cannot change, even by a direct update.
      const changed = await db.as(
        'app_web',
        OWNER_A,
        `UPDATE study_exam_gradings SET earned = 4 WHERE attempt_id = $1 RETURNING seq`,
        [attempt.id],
      );
      expect(changed.rows).toEqual([]);
      const stored = await db.query(
        `SELECT earned, usage FROM study_exam_gradings WHERE attempt_id = $1 AND seq = 1`,
        [attempt.id],
      );
      expect(stored.rows[0]).toMatchObject({
        earned: 3,
        usage: { calls: 2, inputTokens: 20, outputTokens: 10, known: true },
      });
      view = await getAttemptView(web, OWNER_A, attempt.id);
      expect(view.report?.summary).toMatchObject({ earned: 4, pending: 0, state: 'complete' });

      // A review adds a row (the earlier result stays); self scores too.
      await web.withTransaction((tx) => addReview(tx, OWNER_A, attempt.id, 2));
      await expect(
        web.withTransaction((tx) => addReview(tx, OWNER_A, attempt.id, 2)),
      ).rejects.toMatchObject({ code: 'STUDY_GRADING_BUSY' });
      await web.withTransaction((tx) =>
        addSelfGrade(tx, OWNER_A, attempt.id, 2, { earned: 4, note: '我觉得都对' }),
      );
      await expect(
        web.withTransaction((tx) =>
          addSelfGrade(tx, OWNER_A, attempt.id, 2, { earned: 5, note: null }),
        ),
      ).rejects.toMatchObject({ code: 'STUDY_GRADING_INVALID' });
      await expect(
        web.withTransaction((tx) =>
          addSelfGrade(tx, OWNER_A, attempt.id, 3, { earned: 1, note: null }),
        ),
      ).rejects.toMatchObject({ code: 'STUDY_GRADING_NOT_FOUND' });
      gradings = await listAttemptGradings(web, OWNER_A, attempt.id);
      expect(gradings.get(2)!.map((row) => [row.seq, row.kind, row.status, row.earned])).toEqual([
        [1, 'auto', 'succeeded', 3],
        [2, 'review', 'pending', null],
        [3, 'self', 'succeeded', 4],
      ]);
      view = await getAttemptView(web, OWNER_A, attempt.id);
      expect(view.report?.summary).toMatchObject({ earned: 4, pending: 1, selfEarned: 5 });

      // The worker has no access; deleting the paper removes everything.
      await expect(
        db.as('app_worker', OWNER_A, 'SELECT seq FROM study_exam_gradings'),
      ).rejects.toThrow();
      await db.query(`DELETE FROM study_exam_papers WHERE id = 'paper-1'`);
      expect((await db.query('SELECT seq FROM study_exam_gradings')).rows).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
