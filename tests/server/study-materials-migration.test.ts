/**
 * Accounts v23 (study materials + learning tasks, learning plan B02) on a
 * database built by the fresh bootstrap through the latest version:
 * FORCE RLS on every new table, no grants to anon/authenticated, owner
 * isolation and write-time checks for app_web, least privilege for
 * app_worker, and the hosted heavy-task capacity seam counting learning roots.
 *
 * Runs on PGlite always; set TEST_STUDY_MATERIALS_DATABASE_URL to the admin URL
 * of a disposable *_rls_proof database on 127.0.0.1:55432
 * (docker-compose.accounts-rls-proof.yml) to repeat it on real PostgreSQL.
 */
import { randomBytes, randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import type { Queryable } from '@openmaic/storage/document/pg';

import {
  bootstrapFreshAccountsDatabase,
  type FreshBootstrapSource,
} from '@/lib/server/accounts/fresh-bootstrap';
import { LearningTaskQueue } from '@/lib/server/learning-tasks/repository';

const OWNER_A = 'user:aaaaaaaa-0000-4000-8000-00000000000a';
const OWNER_B = 'user:bbbbbbbb-0000-4000-8000-00000000000b';
const TABLES = [
  'study_materials',
  'study_material_versions',
  'study_material_artifacts',
  'study_space_materials',
  'study_session_material_refs',
  'learning_tasks',
  'learning_task_attempts',
];

interface Db extends Queryable {
  source: FreshBootstrapSource;
  close(): Promise<void>;
}

function openPglite(): Db {
  const raw = new PGlite();
  const query = ((sql: string, values?: unknown[]) =>
    raw.query(sql, values ?? [])) as Queryable['query'];
  return {
    source: { connect: async () => ({ query, release: () => undefined }) },
    query,
    close: () => raw.close(),
  };
}

const postgresAdminUrl = process.env.TEST_STUDY_MATERIALS_DATABASE_URL?.trim();

async function openPostgres(): Promise<Db> {
  const parsed = new URL(postgresAdminUrl!);
  if (
    parsed.hostname !== '127.0.0.1' ||
    parsed.port !== '55432' ||
    !parsed.pathname.replace(/^\//, '').endsWith('_rls_proof')
  ) {
    throw new Error('TEST_STUDY_MATERIALS_DATABASE_URL must be a disposable *_rls_proof database');
  }
  const name = `study_materials_${randomBytes(6).toString('hex')}_rls_proof`;
  const admin = new Pool({ connectionString: postgresAdminUrl, max: 1 });
  await admin.query(`CREATE DATABASE ${name}`);
  parsed.pathname = `/${name}`;
  const pool = new Pool({ connectionString: parsed.toString(), max: 1 });
  return {
    source: pool as never,
    query: ((sql: string, values?: unknown[]) => pool.query(sql, values)) as Queryable['query'],
    close: async () => {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

/** Run `body` as `role` (with app.owner_id when given); always rolled back. */
async function as<T>(
  db: Db,
  role: 'app_web' | 'app_worker',
  owner: string | null,
  body: () => Promise<T>,
): Promise<T> {
  await db.query('BEGIN');
  try {
    await db.query(`SET LOCAL ROLE ${role}`);
    if (owner) await db.query("SELECT set_config('app.owner_id', $1, true)", [owner]);
    return await body();
  } finally {
    await db.query('ROLLBACK');
  }
}

async function errorCode(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

async function seed(db: Db) {
  await db.query(
    `INSERT INTO owner_material (id, owner_id, kind, mime, bytes, original_name, oss_key, sha256,
       status, created_at)
     VALUES ('up-a', $1, 'source', 'application/pdf', 10, 'a.pdf', 'materials/a/up-a', $3, 'ready', 0),
            ('up-b', $2, 'source', 'application/pdf', 10, 'b.pdf', 'materials/b/up-b', $3, 'ready', 0),
            ('up-a2', $1, 'source', 'application/pdf', 10, 'a2.pdf', 'materials/a/up-a2', $3, 'ready', 0)`,
    [OWNER_A, OWNER_B, 'c'.repeat(64)],
  );
  await db.query(
    `INSERT INTO study_materials (id, owner_id, title, current_version_id, version_count)
     VALUES ('mat-a', $1, 'A', 'ver-a', 1), ('mat-b', $2, 'B', 'ver-b', 1)`,
    [OWNER_A, OWNER_B],
  );
  await db.query(
    `INSERT INTO study_material_versions (id, owner_id, material_id, version_no, owner_material_id,
       object_key, sha256, mime, byte_size, original_name)
     VALUES ('ver-a', $1, 'mat-a', 1, 'up-a', 'materials/a/up-a', $3, 'application/pdf', 10, 'a.pdf'),
            ('ver-b', $2, 'mat-b', 1, 'up-b', 'materials/b/up-b', $3, 'application/pdf', 10, 'b.pdf')`,
    [OWNER_A, OWNER_B, 'c'.repeat(64)],
  );
  await db.query(
    `INSERT INTO learning_tasks (id, owner_id, root_task_id, kind, idempotency_key, request_hash,
       subject_id)
     VALUES ($1::uuid, $3, 'learning:' || $1::text, 'material_parse', 'k', 'h', 'ver-a'),
            ($2::uuid, $4, 'learning:' || $2::text, 'material_parse', 'k', 'h', 'ver-b')`,
    [randomUUID(), randomUUID(), OWNER_A, OWNER_B],
  );
}

const engines: Array<[string, () => Promise<Db>]> = [['PGlite', async () => openPglite()]];
if (postgresAdminUrl) engines.push(['PostgreSQL', openPostgres]);

describe.each(engines)('accounts v23 study materials (%s)', (_name, open) => {
  it('forces row security and grants nothing to Data API roles', async () => {
    const db = await open();
    try {
      await bootstrapFreshAccountsDatabase(db.source, { stubSupabaseAuth: true });
      const flags = await db.query(
        `SELECT relname FROM pg_class WHERE relname = ANY($1::text[])
           AND relrowsecurity AND relforcerowsecurity ORDER BY relname`,
        [TABLES],
      );
      expect(flags.rows.map((row) => row.relname)).toEqual([...TABLES].sort());
      for (const role of ['anon', 'authenticated']) {
        for (const table of TABLES) {
          const privilege = await db.query(
            `SELECT has_table_privilege($1, $2, 'SELECT') OR has_table_privilege($1, $2, 'INSERT')
                    AS any`,
            [role, `public.${table}`],
          );
          expect(privilege.rows[0]?.any).toBe(false);
        }
      }
    } finally {
      await db.close();
    }
  }, 300_000);

  it('isolates owners for app_web and checks writes', async () => {
    const db = await open();
    try {
      await bootstrapFreshAccountsDatabase(db.source, { stubSupabaseAuth: true });
      await seed(db);
      await as(db, 'app_web', OWNER_A, async () => {
        for (const table of ['study_materials', 'study_material_versions', 'learning_tasks']) {
          const rows = await db.query(`SELECT owner_id FROM ${table}`);
          expect(rows.rows).toEqual([{ owner_id: OWNER_A }]);
        }
        expect(
          (await db.query("UPDATE study_materials SET title='x' WHERE id='mat-b' RETURNING id"))
            .rows,
        ).toEqual([]);
      });
      // A version may only name the owner's own ready upload with its real object key.
      expect(
        await as(db, 'app_web', OWNER_A, () =>
          db.query(
            `INSERT INTO study_material_versions (id, owner_id, material_id, version_no,
               owner_material_id, object_key, sha256, mime, byte_size, original_name)
             VALUES ('ver-steal', $1, 'mat-a', 2, 'up-b', 'materials/b/up-b', $2, 'application/pdf', 10, 'b.pdf')`,
            [OWNER_A, 'c'.repeat(64)],
          ),
        ).then(
          () => 'inserted',
          (error) => error.code,
        ),
      ).toBe('42501');
      expect(
        await as(db, 'app_web', OWNER_A, () =>
          db.query(
            `INSERT INTO study_material_versions (id, owner_id, material_id, version_no,
               owner_material_id, object_key, sha256, mime, byte_size, original_name)
             VALUES ('ver-a2', $1, 'mat-a', 2, 'up-a2', 'materials/a/up-a2', $2, 'application/pdf', 10, 'a2.pdf')
             RETURNING id`,
            [OWNER_A, 'c'.repeat(64)],
          ),
        ).then((result) => result.rows),
      ).toEqual([{ id: 'ver-a2' }]);
      // Writing another owner's id is refused outright.
      expect(
        await errorCode(
          as(db, 'app_web', OWNER_A, () =>
            db.query(
              `INSERT INTO study_materials (id, owner_id, title) VALUES ('mat-x', $1, 'X')`,
              [OWNER_B],
            ),
          ),
        ),
      ).toBe('42501');
      // Session refs must name the owner's own live agent session.
      await db.query(
        `INSERT INTO agent_sessions (id, owner_id, prompt, stage_id, status) VALUES ('session-b', $1, 'p', 'stage-b', 'succeeded')`,
        [OWNER_B],
      );
      expect(
        await errorCode(
          as(db, 'app_web', OWNER_A, () =>
            db.query(
              `INSERT INTO study_session_material_refs
                 (owner_id, session_id, session_material_id, version_id)
               VALUES ($1, 'session-b', 'mat_x', 'ver-a')`,
              [OWNER_A],
            ),
          ),
        ),
      ).toBe('42501');
    } finally {
      await db.close();
    }
  }, 300_000);

  it('gives app_worker only what parsing needs', async () => {
    const db = await open();
    try {
      await bootstrapFreshAccountsDatabase(db.source, { stubSupabaseAuth: true });
      await seed(db);
      await as(db, 'app_worker', null, async () => {
        expect((await db.query('SELECT id FROM learning_tasks')).rows).toHaveLength(2);
        expect((await db.query('SELECT id FROM study_material_versions')).rows).toHaveLength(2);
        await db.query(
          "UPDATE learning_tasks SET status='running', worker_id='w', lease_expires_at=now()+interval '1 minute'",
        );
        await db.query(
          `INSERT INTO study_material_artifacts (id, owner_id, version_id, fingerprint, extractor_id,
             extractor_version, transform_version, artifact_key, text_key, object_keys)
           VALUES ('art-a', $1, 'ver-a', $2, 'unpdf', '1', 'v1', 'k', 't', '["k","t"]')`,
          [OWNER_A, 'd'.repeat(64)],
        );
        await db.query(
          "UPDATE study_material_versions SET active_artifact_id='art-a' WHERE id='ver-a'",
        );
        // The staged-object sweep runs under worker RLS across owners: it removes
        // only keys no committed artifact references, then forgets them.
        await db.query(
          `INSERT INTO learning_task_attempts (id, task_id, owner_id, attempt_no, lease_epoch,
             worker_id, outcome, staged_object_keys, finished_at)
           SELECT gen_random_uuid(), id, owner_id, n, 1, 'w', 'lease_lost', keys::jsonb,
                  now()-interval '1 hour'
             FROM learning_tasks,
                  (VALUES (1, '["k"]'), (2, '["orphan-a"]')) AS staged(n, keys)
            WHERE owner_id=$1`,
          [OWNER_A],
        );
        const inTransaction = {
          connect: async () => ({
            query: (sql: string, values?: unknown[]) =>
              /^(BEGIN|COMMIT|ROLLBACK)$/.test(sql) ? { rows: [] } : db.query(sql, values),
            release() {},
          }),
        };
        const removed: string[] = [];
        const sweeper = new LearningTaskQueue(inTransaction as never, { stagedObjectGraceMs: 0 });
        expect(await sweeper.sweepStagedObjects(async (key) => void removed.push(key))).toBe(1);
        expect(removed).toEqual(['orphan-a']);
        expect(
          (
            await db.query<{ staged_object_keys: string[] }>(
              'SELECT staged_object_keys FROM learning_task_attempts ORDER BY attempt_no',
            )
          ).rows.map((row) => row.staged_object_keys),
        ).toEqual([['k'], []]);
      });
      for (const statement of [
        `INSERT INTO learning_tasks (id, owner_id, root_task_id, kind, idempotency_key, request_hash,
           subject_id) VALUES ('${randomUUID()}', '${OWNER_A}', 'r', 'material_parse', 'z', 'h', 's')`,
        'DELETE FROM learning_tasks',
        "UPDATE study_materials SET title='x'",
        'DELETE FROM study_material_versions',
        "INSERT INTO study_space_materials (owner_id, space_id, material_id) VALUES ('o', 's', 'm')",
        'DELETE FROM study_session_material_refs',
      ]) {
        expect(await errorCode(as(db, 'app_worker', null, () => db.query(statement)))).toBe(
          '42501',
        );
      }
    } finally {
      await db.close();
    }
  }, 300_000);

  it('counts learning roots in the hosted heavy-task capacity seam and readiness', async () => {
    const db = await open();
    try {
      await bootstrapFreshAccountsDatabase(db.source, { stubSupabaseAuth: true });
      await seed(db);
      const now = Date.now();
      const capacity = (operation: string, owner: string, root: string) =>
        db.query(
          `SELECT total_count::int AS total, owner_count::int AS owner
             FROM app_internal.heavy_task_capacity($1,$2,$3,$4,$5,$5,$6,NULL,1,1,false)`,
          [operation, owner, root, now, now - 60_000, now - 3_600_000],
        );
      // Two queued learning roots (A and B) count against the shared queue.
      const queued = await as(db, 'app_web', OWNER_A, () =>
        capacity('queue', OWNER_A, 'generation:new'),
      );
      expect(queued.rows[0]).toEqual({ total: 2, owner: 1 });
      // A running learning root holds a site admission slot for everyone else.
      await db.query(
        `UPDATE learning_tasks SET status='running', worker_id='w',
           lease_expires_at=now()+interval '1 minute' WHERE owner_id=$1`,
        [OWNER_B],
      );
      const admission = await as(db, 'app_web', OWNER_A, () =>
        capacity('admission', OWNER_A, 'generation:new'),
      );
      expect(admission.rows[0]).toEqual({ total: 1, owner: 0 });
      // (The owner-scope guard keys on the login role, which SET ROLE from a
      // superuser cannot reproduce; it is unchanged from v11.)

      const ready = () =>
        as(db, 'app_web', OWNER_A, () =>
          db.query('SELECT worker_live FROM app_internal.learning_task_readiness()'),
        ).then((result) => result.rows[0]?.worker_live);
      expect(await ready()).toBe(false);
      await db.query(
        `INSERT INTO generation_worker_heartbeats (worker_id, pipeline_versions, draining)
         VALUES ('host#learning', '["learning-tasks-v1"]', false)`,
      );
      expect(await ready()).toBe(true);
    } finally {
      await db.close();
    }
  }, 300_000);
});
