/**
 * Accounts v27 (learning events, preferences and Memory controls, learning
 * plan B06): repeatable, forces row security on all five tables, grants
 * nothing to the Data API roles, isolates owners under app_web, keeps events
 * immutable (no UPDATE) and bound to the owner's live courses, and gives the
 * generation worker read-only access to preferences, facts and controls only.
 *
 * Runs on PGlite always; set TEST_STUDY_MEMORY_DATABASE_URL to a dedicated
 * disposable *_rls_proof database on 127.0.0.1:55432 to repeat it on real
 * PostgreSQL. The test drops and recreates minimal tables there.
 */
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { accountsMigrationChecksum } from '@/lib/server/accounts/migrations';
import { ACCOUNTS_SCHEMA_VERSION } from '@/lib/server/accounts/sql-accounts';
import { ACCOUNTS_MIGRATION_27, STUDY_MEMORY_TABLES } from '@/lib/server/accounts/sql-study-memory';
import { applySql } from '@/tests/helpers/model-credentials-db';

const OWNER_A = 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_B = 'user:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const DROP = `DROP TABLE IF EXISTS study_memory_suppressions, study_memory_controls,
  study_memory_facts, study_learner_preferences, study_learning_events, study_spaces,
  stage_meta, document_stages CASCADE`;

/** What v1–v26 leave behind that v27 relies on (minimal shapes). */
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
CREATE TABLE stage_meta (stage_id text PRIMARY KEY, owner_id text NOT NULL, deleted_at timestamptz);
GRANT SELECT ON document_stages, stage_meta TO app_web;
CREATE TABLE study_spaces (
  id text PRIMARY KEY, owner_id text NOT NULL, name text NOT NULL,
  CONSTRAINT study_spaces_owner_id_key UNIQUE (owner_id, id)
);
GRANT SELECT ON study_spaces TO app_web;
INSERT INTO document_stages VALUES ('stage-a', '${OWNER_A}'), ('stage-gone', '${OWNER_A}'), ('stage-b', '${OWNER_B}');
INSERT INTO stage_meta VALUES ('stage-a', '${OWNER_A}', NULL), ('stage-gone', '${OWNER_A}', now()),
  ('stage-b', '${OWNER_B}', NULL);
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

const postgresUrl = process.env.TEST_STUDY_MEMORY_DATABASE_URL?.trim();

function openPostgres(): Db {
  const parsed = new URL(postgresUrl!);
  if (
    parsed.hostname !== '127.0.0.1' ||
    parsed.port !== '55432' ||
    !parsed.pathname.replace(/^\//, '').endsWith('_rls_proof')
  ) {
    throw new Error('TEST_STUDY_MEMORY_DATABASE_URL must be a disposable *_rls_proof database');
  }
  const pool = new Pool({ connectionString: postgresUrl, max: 1 });
  return {
    query: (sql, values) => pool.query(sql, values),
    async as(role, owner, sql, values) {
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
  await applySql(db, ACCOUNTS_MIGRATION_27);
  return db;
}

const EVENT = `INSERT INTO study_learning_events
  (owner_id, event_type, source_type, source_id, source_key, stage_id, occurred_at)
  VALUES ($1, 'course_started', 'study_progress', $2, $3, $2, now())`;

describe('accounts v27 registration', () => {
  it('is the newest accounts version with a stable checksum', () => {
    expect(ACCOUNTS_SCHEMA_VERSION).toBe(27);
    expect(accountsMigrationChecksum(27)).toMatch(/^[a-f0-9]{64}$/);
    expect(ACCOUNTS_MIGRATION_27).toContain('FORCE ROW LEVEL SECURITY');
  });
});

describe.each(engines)('accounts v27 Memory tables (%s)', (_name, open) => {
  it('applies twice, forces row security and grants nothing to Data API roles', async () => {
    const db = await migrated(open);
    try {
      await applySql(db, ACCOUNTS_MIGRATION_27);
      const flags = await db.query(
        `SELECT relname FROM pg_class WHERE relname = ANY($1::text[])
           AND relrowsecurity AND relforcerowsecurity ORDER BY relname`,
        [[...STUDY_MEMORY_TABLES]],
      );
      expect(flags.rows.map((row) => row.relname)).toEqual([...STUDY_MEMORY_TABLES].sort());
      const grants = await db.query(
        `SELECT table_name, grantee FROM information_schema.role_table_grants
          WHERE table_name = ANY($1::text[]) AND grantee IN ('anon', 'authenticated', 'PUBLIC')`,
        [[...STUDY_MEMORY_TABLES]],
      );
      expect(grants.rows).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('isolates owners under app_web and keeps events immutable and on live courses', async () => {
    const db = await migrated(open);
    try {
      await db.as('app_web', OWNER_A, EVENT, [OWNER_A, 'stage-a', 'progress:stage-a:started']);
      await db.as('app_web', OWNER_B, EVENT, [OWNER_B, 'stage-b', 'progress:stage-b:started']);
      // Same source key again: the unique key holds.
      await expect(
        db.as('app_web', OWNER_A, EVENT, [OWNER_A, 'stage-a', 'progress:stage-a:started']),
      ).rejects.toThrow();
      // Another owner's course, a tombstoned course, or another owner's row: refused.
      await expect(
        db.as('app_web', OWNER_A, EVENT, [OWNER_A, 'stage-b', 'progress:stage-b:x']),
      ).rejects.toThrow();
      await expect(
        db.as('app_web', OWNER_A, EVENT, [OWNER_A, 'stage-gone', 'progress:stage-gone:x']),
      ).rejects.toThrow();
      await expect(
        db.as('app_web', OWNER_A, EVENT, [OWNER_B, 'stage-b', 'progress:stage-b:y']),
      ).rejects.toThrow();
      const visible = await db.as('app_web', OWNER_A, 'SELECT owner_id FROM study_learning_events');
      expect(visible.rows).toEqual([{ owner_id: OWNER_A }]);
      await expect(
        db.as('app_web', OWNER_A, `UPDATE study_learning_events SET payload = '{"x":1}'`),
      ).rejects.toThrow();
      const deleted = await db.as(
        'app_web',
        OWNER_A,
        'DELETE FROM study_learning_events RETURNING owner_id',
      );
      expect(deleted.rows).toEqual([{ owner_id: OWNER_A }]);
      expect((await db.query('SELECT count(*)::int AS n FROM study_learning_events')).rows).toEqual(
        [{ n: 1 }],
      );

      await db.as(
        'app_web',
        OWNER_A,
        `INSERT INTO study_learner_preferences (owner_id, space_id, pref_key, value, origin)
         VALUES ($1, 'space-a', 'example_order', 'example_first', 'settings')`,
        [OWNER_A],
      );
      await expect(
        db.as(
          'app_web',
          OWNER_A,
          `INSERT INTO study_learner_preferences (owner_id, space_id, pref_key, value, origin)
           VALUES ($1, 'space-a', 'example_order', 'definition_first', 'settings')`,
          [OWNER_A],
        ),
      ).rejects.toThrow();
      // A space of another owner cannot be named (composite foreign key).
      await expect(
        db.as(
          'app_web',
          OWNER_A,
          `INSERT INTO study_learner_preferences (owner_id, space_id, pref_key, value, origin)
           VALUES ($1, 'space-b', 'hint_mode', 'direct', 'settings')`,
          [OWNER_A],
        ),
      ).rejects.toThrow();
      await db.as(
        'app_web',
        OWNER_B,
        `INSERT INTO study_memory_controls (owner_id, enabled) VALUES ($1, false)`,
        [OWNER_B],
      );
      await db.as(
        'app_web',
        OWNER_B,
        `INSERT INTO study_memory_suppressions (owner_id, kind, target_key, reason)
         VALUES ($1, 'event', 'progress:stage-b:started', 'deleted')`,
        [OWNER_B],
      );
      for (const table of STUDY_MEMORY_TABLES) {
        const rows = await db.as('app_web', OWNER_A, `SELECT owner_id FROM ${table}`);
        expect(rows.rows.every((row) => row.owner_id === OWNER_A)).toBe(true);
      }
      await expect(
        db.as('app_web', OWNER_A, `UPDATE study_memory_suppressions SET reason = 'cleared'`),
      ).rejects.toThrow();
    } finally {
      await db.close();
    }
  });

  it('lets the worker read preferences, facts and controls only', async () => {
    const db = await migrated(open);
    try {
      await db.query(
        `INSERT INTO study_learner_preferences (owner_id, pref_key, value, origin)
         VALUES ($1, 'hint_mode', 'hint_first', 'settings')`,
        [OWNER_A],
      );
      await db.query(
        `INSERT INTO study_memory_facts (id, owner_id, text, origin) VALUES ('mf-1', $1, '高二', 'manual')`,
        [OWNER_A],
      );
      const read = await db.as(
        'app_worker',
        null,
        `SELECT p.value, f.text FROM study_learner_preferences p, study_memory_facts f
          WHERE p.owner_id = $1 AND f.owner_id = $1`,
        [OWNER_A],
      );
      expect(read.rows).toEqual([{ value: 'hint_first', text: '高二' }]);
      await db.as('app_worker', null, 'SELECT * FROM study_memory_controls WHERE owner_id = $1', [
        OWNER_A,
      ]);
      await expect(
        db.as(
          'app_worker',
          null,
          `UPDATE study_learner_preferences SET value = 'direct' WHERE owner_id = $1`,
          [OWNER_A],
        ),
      ).rejects.toThrow();
      await expect(
        db.as('app_worker', null, 'SELECT * FROM study_learning_events'),
      ).rejects.toThrow();
      await expect(
        db.as('app_worker', null, 'SELECT * FROM study_memory_suppressions'),
      ).rejects.toThrow();
    } finally {
      await db.close();
    }
  });
});
