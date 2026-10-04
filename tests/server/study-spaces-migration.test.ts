/**
 * Accounts v22 (study spaces, learning plan B01): repeatable, enforces its
 * checks, and isolates owners under the hosted app_web role — including the
 * write-time rule that links and progress may only name the owner's live
 * course. The repository itself runs as app_web here, so its queries are
 * proven to work under row security.
 *
 * Runs on PGlite always; set TEST_STUDY_SPACES_DATABASE_URL to a dedicated
 * disposable *_rls_proof database on 127.0.0.1:55432
 * (docker-compose.accounts-rls-proof.yml) to repeat it on real PostgreSQL.
 * The test drops and recreates the document, stage_meta and study tables there.
 */
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { DOCUMENT_PG_SCHEMA } from '@openmaic/storage/document/pg';
import type { Queryable } from '@openmaic/storage/document/pg';

import { STAGE_META_SCHEMA } from '@/lib/persistence/stage-meta';
import { ACCOUNTS_MIGRATION_22 } from '@/lib/server/accounts/sql-study-spaces';
import {
  createStudySpace,
  getStudySpace,
  linkStudySpaceCourse,
  listStudySpaces,
  writeCourseProgress,
  type StudyDb,
} from '@/lib/server/study/spaces/repository';
import { applySql, sqlStatements } from '@/tests/helpers/model-credentials-db';

const OWNER_A = 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_B = 'user:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const DROP = `DROP TABLE IF EXISTS study_progress, study_space_courses, study_spaces,
  stage_meta, document_outlines, document_scenes, document_stages, document_folders,
  document_scene_revision, document_stage_revision CASCADE`;

/**
 * What v1–v21 leave behind that v22 relies on: the app roles, the owner GUC,
 * the document tables and stage_meta, and their owner-bound app_web policies
 * (same predicates as the hosted RLS migrations).
 */
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
`;

const DOCUMENT_RLS = `
GRANT SELECT, INSERT, UPDATE, DELETE ON document_stages, document_scenes, document_outlines,
  stage_meta, document_scene_revision TO app_web;
ALTER TABLE document_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_stages FORCE ROW LEVEL SECURITY;
CREATE POLICY document_stages_web_select ON document_stages
  FOR SELECT TO app_web USING (owner_id = app_internal.current_owner_id());
ALTER TABLE stage_meta ENABLE ROW LEVEL SECURITY;
ALTER TABLE stage_meta FORCE ROW LEVEL SECURITY;
CREATE POLICY stage_meta_web_all ON stage_meta
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id());
ALTER TABLE document_scenes ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_scenes FORCE ROW LEVEL SECURITY;
CREATE POLICY document_scenes_web_all ON document_scenes
  FOR ALL TO app_web
  USING (EXISTS (SELECT 1 FROM document_stages s WHERE s.id = document_scenes.stage_id AND s.owner_id = app_internal.current_owner_id()));
ALTER TABLE document_outlines ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_outlines FORCE ROW LEVEL SECURITY;
CREATE POLICY document_outlines_web_all ON document_outlines
  FOR ALL TO app_web
  USING (EXISTS (SELECT 1 FROM document_stages s WHERE s.id = document_outlines.stage_id AND s.owner_id = app_internal.current_owner_id()));
ALTER TABLE document_scene_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_scene_revision FORCE ROW LEVEL SECURITY;
CREATE POLICY document_scene_revision_web_all ON document_scene_revision
  FOR ALL TO app_web
  USING (EXISTS (SELECT 1 FROM document_stages s WHERE s.id = document_scene_revision.stage_id AND s.owner_id = app_internal.current_owner_id()));
`;

interface Db {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  /** Run as `role` with app.owner_id = owner (or unset); commit on success. */
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

const postgresUrl = process.env.TEST_STUDY_SPACES_DATABASE_URL?.trim();

function openPostgres(): Db {
  const parsed = new URL(postgresUrl!);
  if (
    parsed.hostname !== '127.0.0.1' ||
    parsed.port !== '55432' ||
    !parsed.pathname.replace(/^\//, '').endsWith('_rls_proof')
  ) {
    throw new Error('TEST_STUDY_SPACES_DATABASE_URL must be a disposable *_rls_proof database');
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

/** The repository's database, bound to `owner` under app_web like a hosted request. */
function webDb(db: Db, owner: string): StudyDb {
  return {
    query: (text, params) => db.as('app_web', owner, (q) => q.query(text, params)) as never,
    withTransaction: (body) => db.as('app_web', owner, body),
  };
}

async function prepare(db: Db): Promise<void> {
  await applySql(db, BASELINE);
  for (const statement of sqlStatements(DOCUMENT_PG_SCHEMA.replace(/--[^\n]*/g, ''))) {
    await db.query(statement);
  }
  await applySql(db, STAGE_META_SCHEMA);
  await applySql(db, DOCUMENT_RLS);
  await applySql(db, ACCOUNTS_MIGRATION_22);
  await applySql(db, ACCOUNTS_MIGRATION_22);
  const now = Date.now();
  for (const [stage, owner] of [
    ['stage-a', OWNER_A],
    ['stage-a-deleted', OWNER_A],
    ['stage-b', OWNER_B],
  ] as const) {
    await db.query(
      `INSERT INTO document_stages (id, name, created_at, updated_at, owner_id, data)
       VALUES ($1, $1, $2, $2, $3, '{}'::jsonb)`,
      [stage, now, owner],
    );
    await db.query('INSERT INTO stage_meta (stage_id, owner_id) VALUES ($1, $2)', [stage, owner]);
    await db.query(
      `INSERT INTO document_scenes (stage_id, id, scene_order, data)
       VALUES ($1, 's1', 0, '{"actions":[{"id":"a0"},{"id":"a1"}]}'::jsonb)`,
      [stage],
    );
  }
  await db.query("UPDATE stage_meta SET deleted_at = now() WHERE stage_id = 'stage-a-deleted'");
}

const engines: Array<[string, () => Db]> = [['PGlite', openPglite]];
if (postgresUrl) engines.push(['PostgreSQL', openPostgres]);

describe.each(engines)('accounts v22 study spaces (%s)', (_name, open) => {
  it('applies twice, enforces its checks and runs the repository under app_web', async () => {
    const db = open();
    try {
      await prepare(db);

      // Table checks.
      await expect(
        db.query(
          "INSERT INTO study_spaces (id, owner_id, name, status) VALUES ('x', $1, 'x', 'paused')",
          [OWNER_A],
        ),
      ).rejects.toThrow();
      await expect(
        db.query(
          "INSERT INTO study_spaces (id, owner_id, name, status) VALUES ('x', $1, 'x', 'archived')",
          [OWNER_A],
        ),
      ).rejects.toThrow();
      await expect(
        db.query("INSERT INTO study_spaces (id, owner_id, name) VALUES ('x', $1, '')", [OWNER_A]),
      ).rejects.toThrow();

      const a = webDb(db, OWNER_A);
      const space = await createStudySpace(a, OWNER_A, {
        name: '线性代数',
        educationLevel: null,
        subject: null,
        goal: null,
        examDate: null,
        examScope: null,
        timezone: null,
      });
      expect(await linkStudySpaceCourse(a, OWNER_A, space.id, 'stage-a', 'link')).toEqual({
        created: true,
      });
      const progress = await writeCourseProgress(a, OWNER_A, 'stage-a', {
        sceneId: 's1',
        actionIndex: 1,
        baseRevision: null,
        observedAt: new Date().toISOString(),
      });
      expect(progress).toMatchObject({ sceneIndex: 0, actionId: 'a1', revision: 1 });
      expect((await getStudySpace(a, OWNER_A, space.id)).courses).toHaveLength(1);
      expect(await listStudySpaces(webDb(db, OWNER_B), OWNER_B)).toEqual([]);

      // A link's owner must equal its space's owner (composite foreign key).
      await expect(
        db.query(
          "INSERT INTO study_space_courses (owner_id, space_id, stage_id) VALUES ($1, $2, 'stage-b')",
          [OWNER_B, space.id],
        ),
      ).rejects.toThrow();
    } finally {
      await db.close();
    }
  });

  it('isolates owners and refuses foreign or tombstoned courses at write time', async () => {
    const db = open();
    try {
      await prepare(db);
      await db.query(
        "INSERT INTO study_spaces (id, owner_id, name) VALUES ('space-a', $1, 'A'), ('space-b', $2, 'B')",
        [OWNER_A, OWNER_B],
      );

      // Owner A sees only A's rows; no owner binding sees nothing.
      const seen = await db.as('app_web', OWNER_A, (q) => q.query('SELECT id FROM study_spaces'));
      expect(seen.rows).toEqual([{ id: 'space-a' }]);
      const none = await db.as('app_web', null, (q) => q.query('SELECT id FROM study_spaces'));
      expect(none.rows).toEqual([]);
      const touched = await db.as('app_web', OWNER_A, (q) =>
        q.query("UPDATE study_spaces SET name = 'x' WHERE id = 'space-b' RETURNING id"),
      );
      expect(touched.rows).toEqual([]);

      // Writing a row for another owner, or naming another owner's course, is refused.
      await expect(
        db.as('app_web', OWNER_A, (q) =>
          q.query("INSERT INTO study_spaces (id, owner_id, name) VALUES ('space-x', $1, 'x')", [
            OWNER_B,
          ]),
        ),
      ).rejects.toThrow();
      await expect(
        db.as('app_web', OWNER_A, (q) =>
          q.query(
            "INSERT INTO study_space_courses (owner_id, space_id, stage_id) VALUES ($1, 'space-a', 'stage-b')",
            [OWNER_A],
          ),
        ),
      ).rejects.toThrow();
      await expect(
        db.as('app_web', OWNER_A, (q) =>
          q.query(
            "INSERT INTO study_space_courses (owner_id, space_id, stage_id) VALUES ($1, 'space-a', 'stage-a-deleted')",
            [OWNER_A],
          ),
        ),
      ).rejects.toThrow();
      const progressRow = `INSERT INTO study_progress
        (owner_id, stage_id, scene_id, scene_index, scene_count, action_index, action_count,
         furthest_scene_index, observed_at)
        VALUES ($1, $2, 's1', 0, 1, 0, 2, 0, now())`;
      await expect(
        db.as('app_web', OWNER_A, (q) => q.query(progressRow, [OWNER_A, 'stage-b'])),
      ).rejects.toThrow();
      await expect(
        db.as('app_web', OWNER_A, (q) => q.query(progressRow, [OWNER_A, 'stage-a-deleted'])),
      ).rejects.toThrow();
      await db.as('app_web', OWNER_A, (q) => q.query(progressRow, [OWNER_A, 'stage-a']));

      // The worker role has no access at all.
      await expect(
        db.as('app_worker', OWNER_A, (q) => q.query('SELECT id FROM study_spaces')),
      ).rejects.toThrow();
      await expect(
        db.as('app_worker', OWNER_A, (q) => q.query('SELECT stage_id FROM study_progress')),
      ).rejects.toThrow();

      // Deleting a course removes its links and progress, never the space.
      await db.query(
        "INSERT INTO study_space_courses (owner_id, space_id, stage_id) VALUES ($1, 'space-a', 'stage-a')",
        [OWNER_A],
      );
      await db.query("DELETE FROM document_stages WHERE id = 'stage-a'");
      expect((await db.query('SELECT 1 FROM study_space_courses')).rows).toEqual([]);
      expect((await db.query('SELECT 1 FROM study_progress')).rows).toEqual([]);
      expect(
        (await db.query('SELECT id FROM study_spaces WHERE owner_id = $1', [OWNER_A])).rows,
      ).toEqual([{ id: 'space-a' }]);
    } finally {
      await db.close();
    }
  });
});
