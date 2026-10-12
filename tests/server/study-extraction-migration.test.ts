/**
 * Accounts v29 (exercise extraction, learning plan B08): repeatable, forces
 * row security on both new tables, grants nothing to the Data API roles or
 * the worker, isolates owners under app_web (an extraction may only name the
 * owner's own space and parse result), cascades from the parse result and
 * the space, and bounds the figures a question version may carry.
 *
 * Runs on PGlite always; set TEST_STUDY_EXTRACTION_DATABASE_URL to a
 * dedicated disposable *_rls_proof database on 127.0.0.1:55432 to repeat it
 * on real PostgreSQL.
 */
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { accountsMigrationChecksum } from '@/lib/server/accounts/migrations';
import { ACCOUNTS_SCHEMA_VERSION } from '@/lib/server/accounts/sql-accounts';
import { ACCOUNTS_MIGRATION_28 } from '@/lib/server/accounts/sql-study-exams';
import {
  ACCOUNTS_MIGRATION_29,
  STUDY_EXTRACTION_TABLES,
} from '@/lib/server/accounts/sql-study-extraction';
import { applySql } from '@/tests/helpers/model-credentials-db';

const OWNER_A = 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_B = 'user:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const DROP = `DROP TABLE IF EXISTS study_question_candidates, study_question_extractions,
  study_exam_attempts, study_exam_items, study_exam_papers, study_question_versions,
  study_questions, study_concepts, study_material_artifacts, study_spaces, document_stages CASCADE`;

/** What v1–v28 leave behind that v29 relies on (minimal shapes; v28 itself is applied). */
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
CREATE TABLE study_material_artifacts (
  id text PRIMARY KEY, owner_id text NOT NULL,
  CONSTRAINT study_material_artifacts_owner_id_key UNIQUE (owner_id, id)
);
INSERT INTO study_spaces (id, owner_id, name) VALUES ('space-a', '${OWNER_A}', '高数'), ('space-b', '${OWNER_B}', '物理');
INSERT INTO study_material_artifacts (id, owner_id) VALUES ('art-a', '${OWNER_A}'), ('art-b', '${OWNER_B}');
`;

interface Db {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  as(
    role: 'app_web' | 'app_worker',
    owner: string | null,
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
  close(): Promise<void>;
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
    close: () => raw.close(),
  };
}

const postgresUrl = process.env.TEST_STUDY_EXTRACTION_DATABASE_URL?.trim();

function openPostgres(): Db {
  const parsed = new URL(postgresUrl!);
  if (
    parsed.hostname !== '127.0.0.1' ||
    parsed.port !== '55432' ||
    !parsed.pathname.replace(/^\//, '').endsWith('_rls_proof')
  ) {
    throw new Error('TEST_STUDY_EXTRACTION_DATABASE_URL must be a disposable *_rls_proof database');
  }
  const pool = new Pool({ connectionString: postgresUrl, max: 2 });
  return {
    query: (sql, values) => pool.query(sql, values),
    as: async (role, owner, sql, values) => {
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
    },
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
  await applySql(db, ACCOUNTS_MIGRATION_29);
  return db;
}

const EXTRACTION = `INSERT INTO study_question_extractions
  (owner_id, id, space_id, material_id, version_id, artifact_id, page_from, page_to, strategy,
   request_key, stats)
  VALUES ($1, $2, $3, 'smat-1', 'sver-1', $4, 1, 5, 'rules-v1', $2 || '-key', '{}')`;
const CANDIDATE = `INSERT INTO study_question_candidates
  (owner_id, extraction_id, id, position, content, original, source_lines, pages, answer_basis)
  VALUES ($1, $2, $3, 1, '{}', '{}', '[]', '{1}', 'missing')`;

describe('accounts v29 registration', () => {
  it('is the newest accounts version with a stable checksum', () => {
    expect(ACCOUNTS_SCHEMA_VERSION).toBe(29);
    expect(accountsMigrationChecksum(29)).toMatch(/^[a-f0-9]{64}$/);
    expect(ACCOUNTS_MIGRATION_29).toContain('FORCE ROW LEVEL SECURITY');
  });
});

describe.each(engines)('accounts v29 exercise extraction (%s)', (_name, open) => {
  it('applies twice, forces row security and grants only app_web', async () => {
    const db = await migrated(open);
    try {
      await applySql(db, ACCOUNTS_MIGRATION_29);
      const flags = await db.query(
        `SELECT relname FROM pg_class WHERE relname = ANY($1::text[])
           AND relrowsecurity AND relforcerowsecurity ORDER BY relname`,
        [[...STUDY_EXTRACTION_TABLES]],
      );
      expect(flags.rows.map((row) => row.relname)).toEqual([...STUDY_EXTRACTION_TABLES].sort());
      const grants = await db.query(
        `SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
          WHERE table_name = ANY($1::text[])
            AND grantee IN ('anon', 'authenticated', 'PUBLIC', 'app_worker', 'app_web')
          ORDER BY table_name, grantee, privilege_type`,
        [[...STUDY_EXTRACTION_TABLES]],
      );
      expect(grants.rows.filter((row) => row.grantee !== 'app_web')).toEqual([]);
      expect(
        grants.rows
          .filter((row) => row.table_name === 'study_question_candidates')
          .map((row) => row.privilege_type),
      ).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
      const figures = await db.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'study_question_versions' AND column_name = 'figures'`,
      );
      expect(figures.rows).toHaveLength(1);
    } finally {
      await db.close();
    }
  });

  it('isolates owners and only names the owner’s own space and parse result', async () => {
    const db = await migrated(open);
    try {
      await db.as('app_web', OWNER_A, EXTRACTION, [OWNER_A, 'qx-a', 'space-a', 'art-a']);
      await db.as('app_web', OWNER_A, CANDIDATE, [OWNER_A, 'qx-a', 'qc-a']);
      await db.as('app_web', OWNER_B, EXTRACTION, [OWNER_B, 'qx-b', 'space-b', 'art-b']);
      // Another owner's space or parse result, or a row for another owner: refused.
      await expect(
        db.as('app_web', OWNER_A, EXTRACTION, [OWNER_A, 'qx-x', 'space-b', 'art-a']),
      ).rejects.toThrow();
      await expect(
        db.as('app_web', OWNER_A, EXTRACTION, [OWNER_A, 'qx-y', 'space-a', 'art-b']),
      ).rejects.toThrow();
      await expect(
        db.as('app_web', OWNER_A, EXTRACTION, [OWNER_B, 'qx-z', 'space-b', 'art-b']),
      ).rejects.toThrow();
      await expect(
        db.as('app_web', OWNER_B, CANDIDATE, [OWNER_B, 'qx-a', 'qc-x']),
      ).rejects.toThrow();
      // The same request key in a space is one extraction.
      await expect(
        db.as('app_web', OWNER_A, EXTRACTION, [OWNER_A, 'qx-a', 'space-a', 'art-a']),
      ).rejects.toThrow();

      const seenByB = await db.as(
        'app_web',
        OWNER_B,
        `SELECT id FROM study_question_extractions UNION ALL SELECT id FROM study_question_candidates`,
      );
      expect(seenByB.rows).toEqual([{ id: 'qx-b' }]);
      const updated = await db.as(
        'app_web',
        OWNER_B,
        `UPDATE study_question_candidates SET status = 'discarded' RETURNING id`,
      );
      expect(updated.rows).toEqual([]);
      const deleted = await db.as(
        'app_web',
        OWNER_B,
        `DELETE FROM study_question_extractions WHERE id = 'qx-a' RETURNING id`,
      );
      expect(deleted.rows).toEqual([]);
      // A committed candidate names its bank question, and only then.
      await expect(
        db.as(
          'app_web',
          OWNER_A,
          `UPDATE study_question_candidates SET status = 'committed' WHERE id = 'qc-a'`,
        ),
      ).rejects.toThrow();
      await db.as(
        'app_web',
        OWNER_A,
        `UPDATE study_question_candidates SET status = 'committed', question_id = 'q-1' WHERE id = 'qc-a'`,
      );
      // The worker sees nothing.
      await expect(
        db.as('app_worker', OWNER_A, 'SELECT id FROM study_question_extractions'),
      ).rejects.toThrow();
    } finally {
      await db.close();
    }
  });

  it('cascades from the parse result and the space', async () => {
    const db = await migrated(open);
    try {
      await db.as('app_web', OWNER_A, EXTRACTION, [OWNER_A, 'qx-1', 'space-a', 'art-a']);
      await db.as('app_web', OWNER_A, CANDIDATE, [OWNER_A, 'qx-1', 'qc-1']);
      await db.query(`DELETE FROM study_material_artifacts WHERE id = 'art-a'`);
      expect((await db.query('SELECT id FROM study_question_candidates')).rows).toEqual([]);
      await db.query(`INSERT INTO study_material_artifacts (id, owner_id) VALUES ('art-a', $1)`, [
        OWNER_A,
      ]);
      await db.as('app_web', OWNER_A, EXTRACTION, [OWNER_A, 'qx-2', 'space-a', 'art-a']);
      await db.query(`DELETE FROM study_spaces WHERE id = 'space-a'`);
      expect((await db.query('SELECT id FROM study_question_extractions')).rows).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('bounds the figures of a question version', async () => {
    const db = await migrated(open);
    try {
      await db.as(
        'app_web',
        OWNER_A,
        `INSERT INTO study_questions (owner_id, id, space_id, origin, source_fingerprint)
         VALUES ($1, 'q-1', 'space-a', 'material_extracted', 'mat:x')`,
        [OWNER_A],
      );
      const version = (n: number, figures: unknown) =>
        db.as(
          'app_web',
          OWNER_A,
          `INSERT INTO study_question_versions
             (owner_id, question_id, version, qtype, stem, options, answer, verification, gradable,
              content_hash, figures)
           VALUES ($1, 'q-1', $2, 'single', 's', '[]', '[]', 'unverified', false, 'h', $3::jsonb)`,
          [OWNER_A, n, figures === null ? null : JSON.stringify(figures)],
        );
      await version(1, null);
      await version(2, [{ imageId: 'img_1' }]);
      await expect(version(3, [])).rejects.toThrow();
      await expect(
        version(
          4,
          Array.from({ length: 5 }, (_, i) => ({ imageId: `img_${i}` })),
        ),
      ).rejects.toThrow();
      await expect(version(5, { imageId: 'img_1' })).rejects.toThrow();
    } finally {
      await db.close();
    }
  });
});
