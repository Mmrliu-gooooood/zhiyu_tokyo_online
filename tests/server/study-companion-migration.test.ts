/**
 * Accounts v26 (after-class classmate chats, learning plan B05): repeatable,
 * forces row security on study_companion_chats, grants nothing to the Data
 * API roles, isolates owners under app_web (insert/read/delete only — a chat
 * never moves), gives the generation worker read-only access to chats and to
 * the space/material links the runner needs to scope materials, and adds the
 * nullable classmate model_policy column.
 *
 * Runs on PGlite always; set TEST_STUDY_COMPANION_DATABASE_URL to a dedicated
 * disposable *_rls_proof database on 127.0.0.1:55432 to repeat it on real
 * PostgreSQL. The test drops and recreates minimal study tables there.
 */
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { ACCOUNTS_MIGRATION_25 } from '@/lib/server/accounts/sql-study-classmates';
import { ACCOUNTS_MIGRATION_26 } from '@/lib/server/accounts/sql-study-companion';
import { accountsMigrationChecksum } from '@/lib/server/accounts/migrations';
import { ACCOUNTS_SCHEMA_VERSION } from '@/lib/server/accounts/sql-accounts';
import { applySql } from '@/tests/helpers/model-credentials-db';

const OWNER_A = 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_B = 'user:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const DROP = `DROP TABLE IF EXISTS study_companion_chats, study_classmate_avatars,
  study_classmate_materials, study_classmate_revisions, study_classmates, study_space_courses,
  study_space_materials, study_materials, study_spaces CASCADE`;

/** What v1–v25 leave behind that v26 relies on (minimal shapes). */
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
CREATE TABLE study_spaces (
  id text PRIMARY KEY, owner_id text NOT NULL, name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  CONSTRAINT study_spaces_owner_id_key UNIQUE (owner_id, id)
);
CREATE TABLE study_materials (
  id text PRIMARY KEY, owner_id text NOT NULL, title text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  CONSTRAINT study_materials_owner_id_key UNIQUE (owner_id, id)
);
CREATE TABLE study_space_materials (
  owner_id text NOT NULL, space_id text NOT NULL, material_id text NOT NULL,
  PRIMARY KEY (owner_id, space_id, material_id)
);
CREATE TABLE study_space_courses (
  owner_id text NOT NULL, space_id text NOT NULL, stage_id text NOT NULL,
  PRIMARY KEY (owner_id, space_id, stage_id)
);
DO $rls$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['study_spaces','study_materials','study_space_materials','study_space_courses']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('GRANT SELECT, INSERT ON public.%I TO app_web', tbl);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO app_web USING (owner_id = app_internal.current_owner_id()) WITH CHECK (owner_id = app_internal.current_owner_id())',
      tbl || '_web_all', tbl);
  END LOOP;
END
$rls$;
GRANT SELECT ON study_materials TO app_worker;
CREATE POLICY study_materials_worker_select ON study_materials FOR SELECT TO app_worker USING (true);
INSERT INTO study_spaces (id, owner_id, name) VALUES ('space-a', '${OWNER_A}', '高数'), ('space-b', '${OWNER_B}', '物理');
INSERT INTO study_materials (id, owner_id, title) VALUES ('mat-a', '${OWNER_A}', 'A'), ('mat-b', '${OWNER_B}', 'B');
INSERT INTO study_space_materials VALUES ('${OWNER_A}', 'space-a', 'mat-a'), ('${OWNER_B}', 'space-b', 'mat-b');
INSERT INTO study_space_courses VALUES ('${OWNER_A}', 'space-a', 'stage-a');
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

const postgresUrl = process.env.TEST_STUDY_COMPANION_DATABASE_URL?.trim();

function openPostgres(): Db {
  const parsed = new URL(postgresUrl!);
  if (
    parsed.hostname !== '127.0.0.1' ||
    parsed.port !== '55432' ||
    !parsed.pathname.replace(/^\//, '').endsWith('_rls_proof')
  ) {
    throw new Error('TEST_STUDY_COMPANION_DATABASE_URL must be a disposable *_rls_proof database');
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
  await applySql(db, ACCOUNTS_MIGRATION_25);
  await applySql(db, ACCOUNTS_MIGRATION_26);
  await db.query(
    `INSERT INTO study_classmates (id, owner_id, name, role, learning_style, speech_policy, avatar, color)
     VALUES ('cm-aaaaaaaaaaaaaaaa', '${OWNER_A}', '小林', 'student', 'peer', 'active', '/avatars/curious.png', '#10b981'),
            ('cm-bbbbbbbbbbbbbbbb', '${OWNER_B}', '小周', 'student', 'peer', 'active', '/avatars/curious.png', '#10b981')`,
  );
  await db.query(
    `INSERT INTO study_classmate_materials (owner_id, classmate_id, material_id)
     VALUES ('${OWNER_A}', 'cm-aaaaaaaaaaaaaaaa', 'mat-a')`,
  );
  return db;
}

describe('accounts v26 registration', () => {
  it('is the newest accounts version with a stable checksum', () => {
    expect(ACCOUNTS_SCHEMA_VERSION).toBe(26);
    expect(accountsMigrationChecksum(26)).toMatch(/^[a-f0-9]{64}$/);
    expect(ACCOUNTS_MIGRATION_26).toContain('FORCE ROW LEVEL SECURITY');
  });
});

describe.each(engines)('accounts v26 after-class chats (%s)', (_name, open) => {
  it('applies twice, forces row security and grants nothing to Data API roles', async () => {
    const db = await migrated(open);
    try {
      await applySql(db, ACCOUNTS_MIGRATION_26);
      const flags = await db.query(
        `SELECT relname FROM pg_class WHERE relname = 'study_companion_chats'
           AND relrowsecurity AND relforcerowsecurity`,
      );
      expect(flags.rows).toHaveLength(1);
      const grants = await db.query(
        `SELECT grantee, privilege_type FROM information_schema.role_table_grants
          WHERE table_name = 'study_companion_chats' AND grantee IN ('anon', 'authenticated', 'PUBLIC')`,
      );
      expect(grants.rows).toEqual([]);
      const column = await db.query(
        `SELECT is_nullable FROM information_schema.columns
          WHERE table_name = 'study_classmates' AND column_name = 'model_policy'`,
      );
      expect(column.rows).toEqual([{ is_nullable: 'YES' }]);
    } finally {
      await db.close();
    }
  });

  it('isolates owners under app_web and never lets a chat move', async () => {
    const db = await migrated(open);
    try {
      await db.as(
        'app_web',
        OWNER_A,
        `INSERT INTO study_companion_chats (session_id, owner_id, space_id, classmate_id, origin)
         VALUES ('s-a', $1, 'space-a', 'cm-aaaaaaaaaaaaaaaa', '{"stageId":"stage-a"}'::jsonb)`,
        [OWNER_A],
      );
      // Another owner's space or classmate cannot be named (composite foreign keys).
      await expect(
        db.as(
          'app_web',
          OWNER_A,
          `INSERT INTO study_companion_chats (session_id, owner_id, space_id, classmate_id)
           VALUES ('s-x', $1, 'space-b', 'cm-aaaaaaaaaaaaaaaa')`,
          [OWNER_A],
        ),
      ).rejects.toThrow();
      // Writing as somebody else is refused by the policy.
      await expect(
        db.as(
          'app_web',
          OWNER_B,
          `INSERT INTO study_companion_chats (session_id, owner_id, space_id, classmate_id)
           VALUES ('s-y', $1, 'space-a', 'cm-aaaaaaaaaaaaaaaa')`,
          [OWNER_A],
        ),
      ).rejects.toThrow();
      expect((await db.as('app_web', OWNER_B, 'SELECT * FROM study_companion_chats')).rows).toEqual(
        [],
      );
      expect(
        (await db.as('app_web', OWNER_A, 'SELECT session_id FROM study_companion_chats')).rows,
      ).toEqual([{ session_id: 's-a' }]);
      await expect(
        db.as('app_web', OWNER_A, "UPDATE study_companion_chats SET space_id = 'space-a'"),
      ).rejects.toThrow();
      expect(
        (await db.as('app_web', OWNER_B, 'DELETE FROM study_companion_chats RETURNING session_id'))
          .rows,
      ).toEqual([]);
      expect(
        (await db.as('app_web', OWNER_A, 'DELETE FROM study_companion_chats RETURNING session_id'))
          .rows,
      ).toEqual([{ session_id: 's-a' }]);
    } finally {
      await db.close();
    }
  });

  it('lets the worker read chats and material scope, never write', async () => {
    const db = await migrated(open);
    try {
      await db.query(
        `INSERT INTO study_companion_chats (session_id, owner_id, space_id, classmate_id)
         VALUES ('s-a', '${OWNER_A}', 'space-a', 'cm-aaaaaaaaaaaaaaaa')`,
      );
      const scope = await db.as(
        'app_worker',
        null,
        `SELECT m.id FROM study_companion_chats c
           JOIN study_classmate_materials cm ON cm.owner_id = c.owner_id AND cm.classmate_id = c.classmate_id
           JOIN study_space_materials sm ON sm.owner_id = cm.owner_id AND sm.material_id = cm.material_id
                                        AND sm.space_id = c.space_id
           JOIN study_materials m ON m.owner_id = cm.owner_id AND m.id = cm.material_id
          WHERE c.owner_id = $1 AND c.session_id = 's-a'`,
        [OWNER_A],
      );
      expect(scope.rows).toEqual([{ id: 'mat-a' }]);
      expect(
        (await db.as('app_worker', null, 'SELECT stage_id FROM study_space_courses')).rows,
      ).toEqual([{ stage_id: 'stage-a' }]);
      expect(
        (await db.as('app_worker', null, "SELECT name FROM study_spaces WHERE id = 'space-a'"))
          .rows,
      ).toEqual([{ name: '高数' }]);
      await expect(
        db.as(
          'app_worker',
          null,
          `INSERT INTO study_companion_chats (session_id, owner_id, space_id, classmate_id)
           VALUES ('s-w', '${OWNER_A}', 'space-a', 'cm-aaaaaaaaaaaaaaaa')`,
        ),
      ).rejects.toThrow();
      await expect(
        db.as('app_worker', null, 'DELETE FROM study_companion_chats'),
      ).rejects.toThrow();
      await expect(
        db.as('app_worker', null, "UPDATE study_spaces SET name = 'x'"),
      ).rejects.toThrow();
      await expect(
        db.as('app_worker', null, 'DELETE FROM study_classmate_materials'),
      ).rejects.toThrow();
    } finally {
      await db.close();
    }
  });

  it('removes chats with their classmate or space', async () => {
    const db = await migrated(open);
    try {
      await db.query(
        `INSERT INTO study_companion_chats (session_id, owner_id, space_id, classmate_id)
         VALUES ('s-a', '${OWNER_A}', 'space-a', 'cm-aaaaaaaaaaaaaaaa')`,
      );
      await db.query("DELETE FROM study_classmates WHERE id = 'cm-aaaaaaaaaaaaaaaa'");
      expect((await db.query('SELECT * FROM study_companion_chats')).rows).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
