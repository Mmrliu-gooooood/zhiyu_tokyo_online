/**
 * Accounts v25 (classmate templates, learning plan B04): repeatable, forces
 * row security, grants nothing to the Data API roles, isolates owners under
 * the hosted app_web role, keeps revision snapshots and avatars immutable for
 * the web role, and gives the generation worker read-only access to
 * templates and revisions (for Pro sessions) and nothing else.
 *
 * Runs on PGlite always; set TEST_STUDY_CLASSMATES_DATABASE_URL to a
 * dedicated disposable *_rls_proof database on 127.0.0.1:55432
 * (docker-compose.accounts-rls-proof.yml) to repeat it on real PostgreSQL.
 * The test drops and recreates the classmate tables and a minimal
 * study_materials table there.
 */
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import type { Queryable } from '@openmaic/storage/document/pg';

import { ACCOUNTS_MIGRATION_25 } from '@/lib/server/accounts/sql-study-classmates';
import {
  createClassmate,
  listActiveClassmateSnapshots,
  listClassmates,
  readClassmateRevisions,
  saveClassmateAvatar,
  updateClassmate,
} from '@/lib/server/study/classmates/repository';
import type { StudyDb } from '@/lib/server/study/spaces/repository';
import type { ClassmateInput } from '@/lib/study/classmates/contracts';
import { applySql } from '@/tests/helpers/model-credentials-db';

const OWNER_A = 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_B = 'user:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TABLES = [
  'study_classmate_avatars',
  'study_classmate_materials',
  'study_classmate_revisions',
  'study_classmates',
];

const DROP = `DROP TABLE IF EXISTS study_classmate_avatars, study_classmate_materials,
  study_classmate_revisions, study_classmates, study_materials CASCADE`;

/** What v1–v24 leave behind that v25 relies on: roles, the owner GUC and the material library. */
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
CREATE TABLE study_materials (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  CONSTRAINT study_materials_owner_id_key UNIQUE (owner_id, id)
);
ALTER TABLE study_materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE study_materials FORCE ROW LEVEL SECURITY;
GRANT SELECT ON study_materials TO app_web;
CREATE POLICY study_materials_web_all ON study_materials
  FOR ALL TO app_web USING (owner_id = app_internal.current_owner_id());
INSERT INTO study_materials (id, owner_id, title) VALUES
  ('mat-a', '${OWNER_A}', 'A'), ('mat-b', '${OWNER_B}', 'B');
`;

/** The repository also reads the v26 model policy column (B05); v26 itself is tested separately. */
const V26_MODEL_POLICY = 'ALTER TABLE study_classmates ADD COLUMN IF NOT EXISTS model_policy jsonb';

interface Db {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  as<T>(
    role: 'app_web' | 'app_worker',
    owner: string | null,
    body: (q: Queryable) => Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
}

function openPglite(): Db {
  const raw = new PGlite();
  return {
    query: (sql, values) => raw.query(sql, values ?? []) as never,
    as: (role, owner, body) =>
      raw.transaction(async (tx) => {
        await tx.query(`SET LOCAL ROLE ${role}`);
        if (owner) await tx.query("SELECT set_config('app.owner_id',$1,true)", [owner]);
        return body({
          query: async (text, params) => ({
            rows: (await tx.query(text, params ?? [])).rows as never[],
          }),
        });
      }),
    close: () => raw.close(),
  };
}

const postgresUrl = process.env.TEST_STUDY_CLASSMATES_DATABASE_URL?.trim();

function openPostgres(): Db {
  const parsed = new URL(postgresUrl!);
  if (
    parsed.hostname !== '127.0.0.1' ||
    parsed.port !== '55432' ||
    !parsed.pathname.replace(/^\//, '').endsWith('_rls_proof')
  ) {
    throw new Error('TEST_STUDY_CLASSMATES_DATABASE_URL must be a disposable *_rls_proof database');
  }
  const pool = new Pool({ connectionString: postgresUrl, max: 1 });
  return {
    query: (sql, values) => pool.query(sql, values),
    async as(role, owner, body) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL ROLE ${role}`);
        if (owner) await client.query("SELECT set_config('app.owner_id',$1,true)", [owner]);
        const value = await body({
          query: async (text, params) => ({ rows: (await client.query(text, params)).rows }),
        });
        await client.query('COMMIT');
        return value;
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

function roleDb(db: Db, role: 'app_web' | 'app_worker', owner: string | null): StudyDb {
  return {
    query: (text, params) => db.as(role, owner, (q) => q.query(text, params)) as never,
    withTransaction: (body) => db.as(role, owner, body),
  };
}

const input = (overrides: Partial<ClassmateInput> = {}): ClassmateInput => ({
  name: '小林',
  role: 'student',
  persona: '',
  learningStyle: 'encouraging',
  speechPolicy: 'on_demand',
  avatar: '/avatars/curious.png',
  color: '#10b981',
  voice: { source: 'user', providerId: 'qwen-tts', voiceId: 'Cherry' },
  materialIds: [],
  ...overrides,
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]);

const engines: Array<[string, () => Db]> = [['PGlite', openPglite]];
if (postgresUrl) engines.push(['PostgreSQL', openPostgres]);

describe.each(engines)('accounts v25 study classmates (%s)', (_name, open) => {
  it('applies twice, forces row security and grants nothing to Data API roles', async () => {
    const db = open();
    try {
      await applySql(db, BASELINE);
      await applySql(db, ACCOUNTS_MIGRATION_25);
      await applySql(db, ACCOUNTS_MIGRATION_25);
      const flags = await db.query(
        `SELECT relname FROM pg_class WHERE relname = ANY($1::text[])
           AND relrowsecurity AND relforcerowsecurity ORDER BY relname`,
        [TABLES],
      );
      expect(flags.rows.map((row) => row.relname)).toEqual(TABLES);
      const grants = await db.query(
        `SELECT table_name FROM information_schema.role_table_grants
          WHERE grantee IN ('anon', 'authenticated', 'PUBLIC') AND table_name = ANY($1::text[])`,
        [TABLES],
      );
      expect(grants.rows).toEqual([]);
      // Checks hold for the administrator too.
      await expect(
        db.query(
          `INSERT INTO study_classmates (id, owner_id, name, role, learning_style, speech_policy, avatar, color)
           VALUES ('cm-0000000000000000', $1, 'x', 'teacher', 'peer', 'active', '/a.png', '#000000')`,
          [OWNER_A],
        ),
      ).rejects.toThrow();
    } finally {
      await db.close();
    }
  });

  it('isolates owners under app_web and keeps snapshots and avatars immutable', async () => {
    const db = open();
    try {
      await applySql(db, BASELINE);
      await applySql(db, ACCOUNTS_MIGRATION_25);
      await applySql(db, V26_MODEL_POLICY);
      const a = roleDb(db, 'app_web', OWNER_A);
      const b = roleDb(db, 'app_web', OWNER_B);

      const created = await createClassmate(a, OWNER_A, input({ materialIds: ['mat-a'] }));
      const edited = await updateClassmate(a, OWNER_A, created.id, { name: '小林二号' }, 1);
      expect(edited.revision).toBe(2);
      const avatar = await saveClassmateAvatar(a, OWNER_A, PNG, 'image/png');

      // Another owner sees nothing, even when naming the rows directly.
      expect(await listClassmates(b, OWNER_A)).toEqual([]);
      expect(
        (await readClassmateRevisions(b, OWNER_A, [{ classmateId: created.id, revision: 1 }])).size,
      ).toBe(0);
      expect(
        (await b.query('SELECT id FROM study_classmate_avatars WHERE id = $1', [avatar.id])).rows,
      ).toEqual([]);
      // ...and cannot attach the other owner's material.
      await expect(
        createClassmate(a, OWNER_A, input({ materialIds: ['mat-b'] })),
      ).rejects.toMatchObject({ code: 'STUDY_CLASSMATE_MATERIAL_UNAVAILABLE' });
      await expect(
        a.query(
          `INSERT INTO study_classmate_materials (owner_id, classmate_id, material_id)
           VALUES ($1, $2, 'mat-b')`,
          [OWNER_A, created.id],
        ),
      ).rejects.toThrow();

      // The web role may not rewrite history.
      await expect(
        a.query(
          `UPDATE study_classmate_revisions SET snapshot = '{}'::jsonb WHERE classmate_id = $1`,
          [created.id],
        ),
      ).rejects.toThrow();
      await expect(
        a.query('DELETE FROM study_classmate_revisions WHERE classmate_id = $1', [created.id]),
      ).rejects.toThrow();
      await expect(
        a.query('DELETE FROM study_classmate_avatars WHERE id = $1', [avatar.id]),
      ).rejects.toThrow();
      // Writing a row for someone else is refused by the policy.
      await expect(
        a.query(
          `INSERT INTO study_classmate_revisions (owner_id, classmate_id, revision, snapshot)
           VALUES ($1, $2, 9, '{}'::jsonb)`,
          [OWNER_B, created.id],
        ),
      ).rejects.toThrow();
    } finally {
      await db.close();
    }
  });

  it('lets the worker read templates and revisions only, never write', async () => {
    const db = open();
    try {
      await applySql(db, BASELINE);
      await applySql(db, ACCOUNTS_MIGRATION_25);
      await applySql(db, V26_MODEL_POLICY);
      const created = await createClassmate(
        roleDb(db, 'app_web', OWNER_A),
        OWNER_A,
        input({ materialIds: ['mat-a'] }),
      );
      const worker = roleDb(db, 'app_worker', null);
      expect(await listActiveClassmateSnapshots(worker, OWNER_A)).toEqual([
        { id: created.id, revision: 1, snapshot: expect.objectContaining({ name: '小林' }) },
      ]);
      expect(await listActiveClassmateSnapshots(worker, OWNER_B)).toEqual([]);
      expect(
        (await readClassmateRevisions(worker, OWNER_A, [{ classmateId: created.id, revision: 1 }]))
          .size,
      ).toBe(1);
      await expect(
        worker.query(`UPDATE study_classmates SET name = 'x' WHERE id = $1`, [created.id]),
      ).rejects.toThrow();
      await expect(worker.query('SELECT * FROM study_classmate_materials')).rejects.toThrow();
      await expect(worker.query('SELECT * FROM study_classmate_avatars')).rejects.toThrow();
    } finally {
      await db.close();
    }
  });
});
