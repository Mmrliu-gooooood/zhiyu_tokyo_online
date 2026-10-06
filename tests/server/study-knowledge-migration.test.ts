/**
 * Accounts v24 (retrieval and cited answers, learning plan B03) on a database
 * built by the fresh bootstrap through the latest version.
 *
 * PGlite has neither vector nor pgroonga: v24 must still apply, create the
 * answer/index tables with FORCE RLS and skip the chunk storage. Set
 * TEST_STUDY_KNOWLEDGE_DATABASE_URL to the admin URL of a disposable
 * *_rls_proof database on 127.0.0.1 whose server offers both extensions
 * (spikes/b03-candidate-a/Dockerfile builds one) to check the storage itself:
 * owner isolation of chunks and the search function, worker least privilege,
 * and cascades from a deleted material version.
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

const OWNER_A = 'user:aaaaaaaa-0000-4000-8000-00000000000a';
const OWNER_B = 'user:bbbbbbbb-0000-4000-8000-00000000000b';
const TABLES = ['study_knowledge_indexes', 'study_qa_answers', 'study_qa_citations'];

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

const postgresAdminUrl = process.env.TEST_STUDY_KNOWLEDGE_DATABASE_URL?.trim();

async function openPostgres(): Promise<Db> {
  const parsed = new URL(postgresAdminUrl!);
  if (
    parsed.hostname !== '127.0.0.1' ||
    !parsed.pathname.replace(/^\//, '').endsWith('_rls_proof')
  ) {
    throw new Error('TEST_STUDY_KNOWLEDGE_DATABASE_URL must be a disposable *_rls_proof database');
  }
  const name = `study_knowledge_${randomBytes(6).toString('hex')}_rls_proof`;
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

async function as<T>(
  db: Db,
  role: 'app_web' | 'app_worker' | 'anon',
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

const vector = (seed: number) =>
  `[${Array.from({ length: 1024 }, (_, i) => (i === seed ? 1 : 0)).join(',')}]`;

/** Two owners, each with one parsed version, one active index and two chunks. */
async function seed(db: Db, withChunks: boolean) {
  for (const [owner, tag] of [
    [OWNER_A, 'a'],
    [OWNER_B, 'b'],
  ] as const) {
    await db.query(
      `INSERT INTO owner_material (id, owner_id, kind, mime, bytes, original_name, oss_key, sha256,
         status, created_at)
       VALUES ($2, $1, 'source', 'application/pdf', 10, 'x.pdf', $3, $4, 'ready', 0)`,
      [owner, `up-${tag}`, `materials/${tag}/up`, 'c'.repeat(64)],
    );
    await db.query(`INSERT INTO study_spaces (id, owner_id, name) VALUES ($2, $1, 'S')`, [
      owner,
      `sp-${tag}`,
    ]);
    await db.query(
      `INSERT INTO study_materials (id, owner_id, title, current_version_id, version_count)
       VALUES ($2, $1, 'M', $3, 1)`,
      [owner, `mat-${tag}`, `ver-${tag}`],
    );
    await db.query(
      `INSERT INTO study_material_versions (id, owner_id, material_id, version_no,
         owner_material_id, object_key, sha256, mime, byte_size, original_name)
       VALUES ($2, $1, $3, 1, $4, $5, $6, 'application/pdf', 10, 'x.pdf')`,
      [owner, `ver-${tag}`, `mat-${tag}`, `up-${tag}`, `materials/${tag}/up`, 'c'.repeat(64)],
    );
    await db.query(
      `INSERT INTO study_material_artifacts (id, owner_id, version_id, fingerprint, extractor_id,
         extractor_version, transform_version, artifact_key, text_key)
       VALUES ($2, $1, $3, $4, 'unpdf', '1', 't', 'k', 't')`,
      [owner, `art-${tag}`, `ver-${tag}`, 'd'.repeat(64)],
    );
    await db.query(
      `INSERT INTO study_knowledge_indexes (id, owner_id, material_id, version_id, artifact_id,
         chunk_policy, embedding_signature, active, chunk_count)
       VALUES ($2, $1, $3, $4, $5, 'p', 's', true, 2)`,
      [owner, `idx-${tag}`, `mat-${tag}`, `ver-${tag}`, `art-${tag}`],
    );
    if (withChunks) {
      for (const [i, text] of ['导数的定义是极限', '牛顿莱布尼茨公式'].entries()) {
        await db.query(
          `INSERT INTO study_knowledge_chunks (owner_id, index_id, id, material_id, version_id,
             ordinal, block_id, page_number, block_type, text, content_hash, embedding)
           VALUES ($1, $2, $3, $4, $5, $6, 'page_1', 1, 'text', $7, 'h', $8::extensions.halfvec)`,
          [owner, `idx-${tag}`, `c-${tag}-${i}`, `mat-${tag}`, `ver-${tag}`, i, text, vector(i)],
        );
      }
    }
    await db.query(
      `INSERT INTO study_qa_answers (id, owner_id, space_id, question, status, body)
       VALUES ($2, $1, $3, 'q', 'answered', '{}'::jsonb)`,
      [owner, `ans-${tag}`, `sp-${tag}`],
    );
    await db.query(
      `INSERT INTO study_qa_citations (owner_id, answer_id, ref, ordinal, material_id, version_id,
         artifact_id, chunk_id, block_id, page_number, quote, content_hash)
       VALUES ($1, $2, 'E1', 0, $3, $4, $5, $6, 'page_1', 1, '导数', 'h')`,
      [owner, `ans-${tag}`, `mat-${tag}`, `ver-${tag}`, `art-${tag}`, `c-${tag}-0`],
    );
  }
}

const engines: Array<[string, () => Promise<Db>, boolean]> = [
  ['PGlite', async () => openPglite(), false],
];
if (postgresAdminUrl) engines.push(['PostgreSQL + vector + pgroonga', openPostgres, true]);

describe.each(engines)('accounts v24 study knowledge (%s)', (_name, open, storage) => {
  it('applies, forces row security and grants nothing to Data API roles', async () => {
    const db = await open();
    try {
      await bootstrapFreshAccountsDatabase(db.source, { stubSupabaseAuth: true });
      const version = await db.query<{ version: number }>(
        'SELECT max(version)::int AS version FROM app_schema_migrations',
      );
      expect(version.rows[0]?.version).toBe(24);
      const expected = storage ? [...TABLES, 'study_knowledge_chunks'] : TABLES;
      const flags = await db.query<{ relname: string }>(
        `SELECT relname FROM pg_class WHERE relname = ANY($1::text[])
           AND relrowsecurity AND relforcerowsecurity ORDER BY relname`,
        [expected],
      );
      expect(flags.rows.map((row) => row.relname)).toEqual([...expected].sort());
      const present = await db.query<{ chunks: string | null; search: string | null }>(
        `SELECT to_regclass('public.study_knowledge_chunks')::text AS chunks,
                to_regproc('public.study_knowledge_search')::text AS search`,
      );
      expect(Boolean(present.rows[0]?.chunks)).toBe(storage);
      expect(Boolean(present.rows[0]?.search)).toBe(storage);
      for (const role of ['anon', 'authenticated']) {
        for (const table of expected) {
          const privilege = await db.query<{ any: boolean }>(
            `SELECT has_table_privilege($1, $2, 'SELECT') OR has_table_privilege($1, $2, 'INSERT')
                    AS any`,
            [role, `public.${table}`],
          );
          expect(privilege.rows[0]?.any).toBe(false);
        }
      }
      // The new task kind is accepted, unknown kinds still are not.
      const insertTask = (kind: string) =>
        db.query(
          `INSERT INTO learning_tasks (id, owner_id, root_task_id, kind, idempotency_key,
             request_hash, subject_id) VALUES ($1, $2, $3, $4, $5, 'h', 'index:ver')`,
          [randomUUID(), OWNER_A, `learning:${randomUUID()}`, kind, randomUUID()],
        );
      await insertTask('material_index');
      expect(await errorCode(insertTask('material_magic'))).toBe('23514');
    } finally {
      await db.close();
    }
  }, 300_000);

  it('isolates owners and cascades from a deleted version', async () => {
    const db = await open();
    try {
      await bootstrapFreshAccountsDatabase(db.source, { stubSupabaseAuth: true });
      await seed(db, storage);
      await as(db, 'app_web', OWNER_A, async () => {
        for (const table of ['study_knowledge_indexes', 'study_qa_answers', 'study_qa_citations']) {
          const rows = await db.query(`SELECT owner_id FROM ${table}`);
          expect(rows.rows).toEqual([{ owner_id: OWNER_A }]);
        }
      });
      // Web may not write indexes (only the worker's lease-fenced commit does).
      expect(
        await as(db, 'app_web', OWNER_A, () =>
          errorCode(db.query(`UPDATE study_knowledge_indexes SET active=false WHERE id='idx-a'`)),
        ),
      ).toBe('42501');
      // A citation can only name the caller's own answer (composite key and RLS).
      expect(
        await as(db, 'app_web', OWNER_A, () =>
          errorCode(
            db.query(
              `INSERT INTO study_qa_citations (owner_id, answer_id, ref, ordinal, material_id,
                 version_id, artifact_id, chunk_id, block_id, quote, content_hash)
               VALUES ($1, 'ans-b', 'E2', 1, 'mat-a', 'ver-a', 'art-a', 'c', 'b', 'q', 'h')`,
              [OWNER_A],
            ),
          ),
        ),
      ).toMatch(/^(42501|23503)$/);
      if (storage) {
        await as(db, 'app_web', OWNER_A, async () => {
          expect((await db.query('SELECT owner_id FROM study_knowledge_chunks')).rows).toEqual([
            { owner_id: OWNER_A },
            { owner_id: OWNER_A },
          ]);
          const own = await db.query<{ chunk_id: string; lexical_rank: number | null }>(
            `SELECT * FROM study_knowledge_search($1, $2, $3, $4, 5, 30)`,
            [OWNER_A, ['idx-a'], ['导数'], vector(0)],
          );
          expect(own.rows[0]?.chunk_id).toBe('c-a-0');
          expect(own.rows[0]?.lexical_rank).toBe(1);
          // Naming another owner and their index finds nothing: RLS applies inside.
          const foreign = await db.query(
            `SELECT * FROM study_knowledge_search($1, $2, $3, $4, 5, 30)`,
            [OWNER_B, ['idx-b'], ['导数'], vector(0)],
          );
          expect(foreign.rows).toEqual([]);
          // Lexical-only search (no embedding) still works.
          const lexical = await db.query<{ chunk_id: string; vector_rank: number | null }>(
            `SELECT * FROM study_knowledge_search($1, $2, $3, NULL, 5, 30)`,
            [OWNER_A, ['idx-a'], ['公式']],
          );
          expect(lexical.rows.map((row) => [row.chunk_id, row.vector_rank])).toEqual([
            ['c-a-1', null],
          ]);
        });
        // The worker writes chunks but may not run the search function.
        expect(
          await as(db, 'app_worker', null, () =>
            errorCode(
              db.query(`SELECT * FROM study_knowledge_search('x', '{}', '{}', NULL, 1, 1)`),
            ),
          ),
        ).toBe('42501');
        expect(
          await as(db, 'anon', null, () =>
            errorCode(db.query('SELECT 1 FROM study_knowledge_chunks')),
          ),
        ).toBe('42501');
      }
      // Deleting a version (permanent material delete) removes its index, chunks
      // and the citations that quote it; the answer itself stays.
      await db.query(`DELETE FROM study_material_versions WHERE id='ver-a'`);
      const left = await db.query<{ indexes: number; citations: number; answers: number }>(
        `SELECT (SELECT count(*)::int FROM study_knowledge_indexes WHERE owner_id=$1) AS indexes,
                (SELECT count(*)::int FROM study_qa_citations WHERE owner_id=$1) AS citations,
                (SELECT count(*)::int FROM study_qa_answers WHERE owner_id=$1) AS answers`,
        [OWNER_A],
      );
      expect(left.rows[0]).toEqual({ indexes: 0, citations: 0, answers: 1 });
      if (storage) {
        const chunks = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM study_knowledge_chunks WHERE owner_id=$1`,
          [OWNER_A],
        );
        expect(chunks.rows[0]?.n).toBe(0);
      }
    } finally {
      await db.close();
    }
  }, 300_000);
});
