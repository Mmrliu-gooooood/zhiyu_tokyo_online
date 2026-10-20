/**
 * Accounts v34 (explanations on request, learning plan B13): registered and
 * repeatable; the table forces row security and is granted to app_web
 * owner-bound only (no worker access); the shape constraints hold (known
 * forms and states, content when ready, one idempotency key per owner);
 * another owner sees nothing; rows cascade from their wrong item and space.
 *
 * Runs on PGlite.
 */
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

import { ACCOUNT_MIGRATIONS, accountsMigrationChecksum } from '@/lib/server/accounts/migrations';
import { ACCOUNTS_SCHEMA_VERSION } from '@/lib/server/accounts/sql-accounts';
import {
  ACCOUNTS_MIGRATION_34,
  STUDY_EXPLANATION_TABLES,
} from '@/lib/server/accounts/sql-study-explanations';
import { ACCOUNTS_MIGRATION_27 } from '@/lib/server/accounts/sql-study-memory';
import { ACCOUNTS_MIGRATION_28 } from '@/lib/server/accounts/sql-study-exams';
import { ACCOUNTS_MIGRATION_30 } from '@/lib/server/accounts/sql-study-grading';
import { ACCOUNTS_MIGRATION_31 } from '@/lib/server/accounts/sql-study-wrongbook';
import { ACCOUNTS_MIGRATION_32 } from '@/lib/server/accounts/sql-study-practice';
import { ACCOUNTS_MIGRATION_33 } from '@/lib/server/accounts/sql-study-review';
import { applySql } from '@/tests/helpers/model-credentials-db';

const OWNER_A = 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_B = 'user:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

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
CREATE TABLE document_stages (id text PRIMARY KEY, owner_id text NOT NULL);
CREATE TABLE study_spaces (
  id text PRIMARY KEY, owner_id text NOT NULL, name text NOT NULL,
  exam_date date, exam_scope text, timezone text,
  CONSTRAINT study_spaces_owner_id_key UNIQUE (owner_id, id)
);
CREATE TABLE stage_meta (stage_id text PRIMARY KEY, owner_id text NOT NULL, deleted_at timestamptz);
CREATE TABLE study_space_courses (owner_id text, space_id text, stage_id text);
INSERT INTO study_spaces (id, owner_id, name)
  VALUES ('space-a', '${OWNER_A}', '高数'), ('space-b', '${OWNER_B}', '物理');
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

async function migrated(): Promise<Db> {
  const raw = new PGlite();
  const db: Db = {
    query: (sql, values) => raw.query(sql, values ?? []) as never,
    as: (role, owner, sql, values) =>
      raw.transaction(async (tx) => {
        await tx.query(`SET LOCAL ROLE ${role}`);
        if (owner) await tx.query("SELECT set_config('app.owner_id',$1,true)", [owner]);
        return (await tx.query(sql, values ?? [])) as never;
      }),
    close: () => raw.close(),
  };
  await applySql(db, BASELINE);
  for (const sql of [
    ACCOUNTS_MIGRATION_27,
    ACCOUNTS_MIGRATION_28,
    ACCOUNTS_MIGRATION_30,
    ACCOUNTS_MIGRATION_31,
    ACCOUNTS_MIGRATION_32,
    ACCOUNTS_MIGRATION_33,
    ACCOUNTS_MIGRATION_34,
  ]) {
    await applySql(db, sql);
  }
  return db;
}

async function seedItem(db: Db, owner: string, space: string, id: string) {
  await db.query(
    `INSERT INTO study_wrong_items (owner_id, id, space_id, question_key, source_type, concepts)
     VALUES ($1, $2, $3, 'bank:q-' || $2, 'exam_attempt', ARRAY['导数'])`,
    [owner, id, space],
  );
}

function insert(
  db: Db,
  values: {
    owner?: string;
    id?: string;
    item?: string;
    space?: string;
    format?: string;
    status?: string;
    content?: string | null;
    key?: string;
  },
) {
  return db.query(
    `INSERT INTO study_explanations
       (owner_id, id, space_id, item_id, format, status, request, reuse_key, content, call_cap,
        idempotency_key, request_hash)
     VALUES ($1, $2, $3, $4, $5, $6, '{"version":1}', 'reuse', $7::jsonb, 2, $8, 'hash')`,
    [
      values.owner ?? OWNER_A,
      values.id ?? 'ex-aaaaaaaaaaaa',
      values.space ?? 'space-a',
      values.item ?? 'wi-a',
      values.format ?? 'text',
      values.status ?? 'pending',
      values.content === undefined ? null : values.content,
      values.key ?? 'explain-key-0001',
    ],
  );
}

describe('accounts v34 explanations on request', () => {
  it('is registered with a checksum', () => {
    expect(ACCOUNTS_SCHEMA_VERSION).toBe(34);
    expect(ACCOUNT_MIGRATIONS.at(-1)?.version).toBe(34);
    expect(accountsMigrationChecksum(34)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is repeatable, forces row security and grants app_web only', async () => {
    const db = await migrated();
    try {
      await applySql(db, ACCOUNTS_MIGRATION_34);
      const security = await db.query(
        `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE relname = ANY($1::text[])`,
        [[...STUDY_EXPLANATION_TABLES]],
      );
      expect(security.rows).toEqual([
        { relname: 'study_explanations', relrowsecurity: true, relforcerowsecurity: true },
      ]);
      const grants = await db.query(
        `SELECT grantee, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privileges
           FROM information_schema.role_table_grants
          WHERE table_name = 'study_explanations'
            AND grantee IN ('app_web','app_worker','anon','authenticated','PUBLIC')
          GROUP BY grantee ORDER BY grantee`,
      );
      expect(grants.rows).toEqual([
        { grantee: 'app_web', privileges: 'DELETE,INSERT,SELECT,UPDATE' },
      ]);
      await expect(db.as('app_worker', null, 'SELECT 1 FROM study_explanations')).rejects.toThrow();
    } finally {
      await db.close();
    }
  });

  it('keeps the shape and the owner boundary, and cascades', async () => {
    const db = await migrated();
    try {
      await seedItem(db, OWNER_A, 'space-a', 'wi-a');
      await seedItem(db, OWNER_B, 'space-b', 'wi-b');
      await expect(insert(db, { format: 'video' })).rejects.toThrow();
      await expect(insert(db, { status: 'done' })).rejects.toThrow();
      // Ready needs content (a course: its course).
      await expect(insert(db, { status: 'ready' })).rejects.toThrow();
      await insert(db, { status: 'ready', content: '{"kind":"text"}' });
      await expect(insert(db, { id: 'ex-bbbbbbbbbbbb' })).rejects.toThrow(); // same idempotency key
      await insert(db, { id: 'ex-cccccccccccc', format: 'course', key: 'explain-key-0002' });
      await insert(db, {
        owner: OWNER_B,
        id: 'ex-dddddddddddd',
        item: 'wi-b',
        space: 'space-b',
        key: 'explain-key-0001',
      });

      // Each owner sees and changes only their own rows.
      const mine = await db.as('app_web', OWNER_A, 'SELECT id FROM study_explanations ORDER BY id');
      expect(mine.rows.map((row) => row.id)).toEqual(['ex-aaaaaaaaaaaa', 'ex-cccccccccccc']);
      const touched = await db.as(
        'app_web',
        OWNER_B,
        `UPDATE study_explanations SET status = 'cancelled' WHERE id = 'ex-cccccccccccc' RETURNING id`,
      );
      expect(touched.rows).toHaveLength(0);
      await expect(
        db.as(
          'app_web',
          OWNER_B,
          `INSERT INTO study_explanations
             (owner_id, id, space_id, item_id, format, request, reuse_key, call_cap,
              idempotency_key, request_hash)
           VALUES ($1, 'ex-eeeeeeeeeeee', 'space-a', 'wi-a', 'text', '{}', 'r', 2, 'explain-key-0009', 'h')`,
          [OWNER_A],
        ),
      ).rejects.toThrow();

      // Deleting the wrong item deletes what was written from it; the space the rest.
      await db.query(`DELETE FROM study_wrong_items WHERE id = 'wi-a'`);
      const left = await db.query('SELECT id FROM study_explanations WHERE owner_id = $1', [
        OWNER_A,
      ]);
      expect(left.rows).toHaveLength(0);
      await db.query(`DELETE FROM study_spaces WHERE id = 'space-b'`);
      expect((await db.query('SELECT 1 FROM study_explanations')).rows).toHaveLength(0);
    } finally {
      await db.close();
    }
  });
});
