/**
 * Physical purge of deleted courses (lib/server/courses/purge.ts): after the
 * grace period a tombstoned course loses its scenes, outline, generation job
 * graph and the media only it used (blobs handed to the collector), while its
 * tombstone stays so a stale device cannot re-create it. Live courses, other
 * owners' media, media another course still uses, courses inside the grace
 * period and courses deleted before the configured boundary are untouched.
 */
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureDocumentSchema } from '@openmaic/storage/document/pg';
import { ensureAssetSchema } from '@openmaic/storage/asset/pg';
import type { Queryable } from '@openmaic/storage/document/pg';

import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import { migrateGenerationSchema } from '@/lib/server/generation-jobs/migrations';
import { GenerationJobRepository } from '@/lib/server/generation-jobs/repository';
import {
  findPurgeableCourses,
  purgeDeletedCourse,
  type CoursePurgeConfig,
} from '@/lib/server/courses/purge';
import {
  assertGenerationUploadQuota,
  generationUploadBytes,
  GENERATION_UPLOAD_ORIGIN,
} from '@/lib/server/generation-jobs/upload-quota';

class TestPool {
  constructor(readonly db: PGlite) {}
  query<R extends Record<string, unknown>>(sql: string, args?: unknown[]) {
    return this.db.query<R>(sql, args);
  }
  async connect() {
    return { query: (sql: string, args?: unknown[]) => this.db.query(sql, args), release() {} };
  }
}

let db: PGlite;
let repo: GenerationJobRepository;
const input = {
  version: 1,
  requirements: { requirement: 'Course', interactiveMode: true },
  review: { mode: 'auto' },
};

function q(): Queryable {
  return {
    query: async (sql, params) => ({ rows: (await db.query(sql, params ?? [])).rows as never[] }),
  };
}

let assetCounter = 0;
async function asset(owner: string, meta: Record<string, unknown> = {}): Promise<string> {
  assetCounter += 1;
  const id = `ast_${String(assetCounter).padStart(26, '0')}`;
  const hash = `sha256-${String(assetCounter).padStart(64, '0')}`;
  await db.query('INSERT INTO asset_blobs (content_hash, byte_size) VALUES ($1, 1000)', [hash]);
  await db.query(
    `INSERT INTO asset_entries (id, principal, content_hash, mime, meta, revision, created_at)
     VALUES ($1, $2, $3, 'audio/mpeg', $4::jsonb, 1, 0)`,
    [id, owner, hash, JSON.stringify(meta)],
  );
  return id;
}

async function course(owner: string, key: string, sceneAssets: string[], jobAsset?: string) {
  const job = await repo.createJob(owner, key, input);
  await db.query(
    `INSERT INTO document_scenes (stage_id, id, scene_order, data) VALUES ($1, 's1', 0, $2::jsonb)`,
    [
      job.stageId,
      JSON.stringify({ actions: sceneAssets.map((id) => ({ audioUrl: `/api/assets/${id}` })) }),
    ],
  );
  if (jobAsset) {
    await db.query(
      `INSERT INTO generation_job_assets
         (job_id, logical_key, asset_id, role, lifecycle, asset_revision, content_hash)
       SELECT $1, 'tts:s1', id, 'output', 'attached', revision, content_hash
         FROM asset_entries WHERE id = $2`,
      [job.jobId, jobAsset],
    );
  }
  return job.stageId;
}

async function tombstone(stageId: string, minutesAgo: number) {
  await db.query(
    `UPDATE stage_meta SET deleted_at = clock_timestamp() - $2 * interval '1 minute'
      WHERE stage_id = $1`,
    [stageId, minutesAgo],
  );
  await db.query(
    "UPDATE generation_jobs SET status='cancelled', worker_id=NULL, lease_expires_at=NULL WHERE stage_id=$1",
    [stageId],
  );
}

const config: CoursePurgeConfig = { graceMs: 10 * 60_000, deletedSince: null, batchSize: 10 };

beforeEach(async () => {
  db = new PGlite();
  const pool = new TestPool(db);
  await ensureDocumentSchema(pool as never);
  await ensureStageMetaSchema(pool as never);
  await ensureAssetSchema(pool as never);
  await migrateGenerationSchema(pool as never);
  repo = new GenerationJobRepository(pool as never);
}, 30_000);

afterEach(async () => {
  await db.close();
});

describe('deleted course purge', () => {
  it('removes a deleted course and the media only it used, keeping its tombstone', async () => {
    const own = await asset('owner');
    const jobOutput = await asset('owner');
    const shared = await asset('owner');
    const foreign = await asset('other');
    const deleted = await course('owner', 'deleted', [own, shared, foreign], jobOutput);
    const live = await course('owner', 'live', [shared]);
    await tombstone(deleted, 30);

    expect(await findPurgeableCourses(q(), config)).toEqual([deleted]);
    const result = await purgeDeletedCourse(q(), deleted);
    expect(result).toEqual({ stageId: deleted, assetsRemoved: 2, blobsReleased: 2 });

    const count = async (sql: string, ...params: unknown[]) =>
      Number((await db.query<{ n: number }>(sql, params)).rows[0]!.n);
    expect(
      await count('SELECT count(*)::int n FROM document_scenes WHERE stage_id=$1', deleted),
    ).toBe(0);
    expect(
      await count('SELECT count(*)::int n FROM generation_jobs WHERE stage_id=$1', deleted),
    ).toBe(0);
    expect(
      await count('SELECT count(*)::int n FROM generation_ownership WHERE stage_id=$1', deleted),
    ).toBe(0);
    // The emptied stage row anchors the tombstone that blocks re-creation.
    const stage = await db.query<{ name: string; data: Record<string, unknown> }>(
      'SELECT name, data FROM document_stages WHERE id=$1',
      [deleted],
    );
    expect(stage.rows[0]?.name).toBe('');
    expect(Object.keys(stage.rows[0]!.data)).toEqual(['purgedAt']);
    expect(
      await count(
        'SELECT count(*)::int n FROM stage_meta WHERE stage_id=$1 AND deleted_at IS NOT NULL',
        deleted,
      ),
    ).toBe(1);
    // Media: the course's own entries go and their blobs await the collector;
    // media another live course uses, and another owner's media, stay.
    const entries = (
      await db.query<{ id: string }>('SELECT id FROM asset_entries ORDER BY id')
    ).rows.map((row) => row.id);
    expect(entries).toEqual([shared, foreign].sort());
    expect(
      await count('SELECT count(*)::int n FROM asset_blobs WHERE unreferenced_at IS NOT NULL'),
    ).toBe(2);
    // The live course is untouched; a second pass finds nothing to do.
    expect(await count('SELECT count(*)::int n FROM document_scenes WHERE stage_id=$1', live)).toBe(
      1,
    );
    expect(await findPurgeableCourses(q(), config)).toEqual([]);
    expect(await purgeDeletedCourse(q(), deleted)).toBeNull();
    expect(await purgeDeletedCourse(q(), live)).toBeNull();
  });

  it('waits out the grace period and respects the deleted-since boundary', async () => {
    const recent = await course('owner', 'recent', []);
    const old = await course('owner', 'old', []);
    await tombstone(recent, 2);
    await tombstone(old, 24 * 60);
    expect(await findPurgeableCourses(q(), config)).toEqual([old]);
    const since = new Date(Date.now() - 60 * 60_000);
    expect(await findPurgeableCourses(q(), { ...config, deletedSince: since })).toEqual([]);
    expect(await findPurgeableCourses(q(), { ...config, graceMs: 60_000 })).toEqual([old, recent]);
  });
});

describe('generation upload quota', () => {
  it('counts only tagged uploads, never generated course media', async () => {
    await asset('owner');
    await asset('owner');
    await asset('owner', { origin: GENERATION_UPLOAD_ORIGIN });
    expect(await generationUploadBytes(q(), 'owner')).toBe(1000);
    await assertGenerationUploadQuota(q(), 'owner', 1000, 2000);
    await expect(assertGenerationUploadQuota(q(), 'owner', 1001, 2000)).rejects.toMatchObject({
      code: 'ASSET_QUOTA_EXCEEDED',
      httpStatus: 413,
    });
  });
});

// Real PostgreSQL with the hosted schema, row security and revision triggers:
// set TEST_COURSE_PURGE_DATABASE_URL to the admin URL of a disposable
// *_rls_proof database on 127.0.0.1:55432 (docker-compose.accounts-rls-proof.yml).
const postgresAdminUrl = process.env.TEST_COURSE_PURGE_DATABASE_URL?.trim();

describe.skipIf(!postgresAdminUrl)('deleted course purge (PostgreSQL, app_worker)', () => {
  it('purges under the worker role and leaves the hosted tombstone in place', async () => {
    const { randomBytes } = await import('node:crypto');
    const { Pool } = await import('pg');
    const { bootstrapFreshAccountsDatabase } =
      await import('@/lib/server/accounts/fresh-bootstrap');
    const parsed = new URL(postgresAdminUrl!);
    if (
      parsed.hostname !== '127.0.0.1' ||
      parsed.port !== '55432' ||
      !parsed.pathname.replace(/^\//, '').endsWith('_rls_proof')
    ) {
      throw new Error('TEST_COURSE_PURGE_DATABASE_URL must be a disposable *_rls_proof database');
    }
    const name = `course_purge_${randomBytes(6).toString('hex')}_rls_proof`;
    const admin = new Pool({ connectionString: postgresAdminUrl, max: 1 });
    await admin.query(`CREATE DATABASE ${name}`);
    parsed.pathname = `/${name}`;
    const pool = new Pool({ connectionString: parsed.toString(), max: 1 });
    const pg: Queryable = {
      query: async (sql, params) => ({ rows: (await pool.query(sql, params)).rows }),
    };
    try {
      await bootstrapFreshAccountsDatabase(pool as never, { stubSupabaseAuth: true });
      const owner = 'user:aaaaaaaa-0000-4000-8000-00000000000a';
      await pool.query(
        `INSERT INTO document_stages (id, name, created_at, updated_at, owner_id, data)
         VALUES ('gone', 'Gone', 0, 0, $1, '{"id":"gone"}'), ('kept', 'Kept', 0, 0, $1, '{"id":"kept"}')`,
        [owner],
      );
      await pool.query(
        `INSERT INTO stage_meta (stage_id, owner_id, deleted_at)
         VALUES ('gone', $1, clock_timestamp() - interval '1 hour'), ('kept', $1, NULL)`,
        [owner],
      );
      await pool.query(
        `INSERT INTO asset_blobs (content_hash, byte_size) VALUES ($1, 10), ($2, 10)`,
        [`sha256-${'1'.repeat(64)}`, `sha256-${'2'.repeat(64)}`],
      );
      await pool.query(
        `INSERT INTO asset_entries (id, principal, content_hash, mime, meta, revision, created_at)
         VALUES ('ast_${'1'.repeat(26)}', $1, $2, 'audio/mpeg', '{}', 1, 0),
                ('ast_${'2'.repeat(26)}', $1, $3, 'audio/mpeg', '{}', 1, 0)`,
        [owner, `sha256-${'1'.repeat(64)}`, `sha256-${'2'.repeat(64)}`],
      );
      await pool.query(
        `INSERT INTO document_scenes (stage_id, id, scene_order, data)
         VALUES ('gone', 's1', 0, '{"audio":"ast_${'1'.repeat(26)}"}'),
                ('kept', 's1', 0, '{"audio":"ast_${'2'.repeat(26)}"}')`,
      );

      await pool.query('BEGIN');
      await pool.query('SET LOCAL ROLE app_worker');
      const purgeConfig: CoursePurgeConfig = { graceMs: 60_000, deletedSince: null, batchSize: 5 };
      expect(await findPurgeableCourses(pg, purgeConfig)).toEqual(['gone']);
      expect(await purgeDeletedCourse(pg, 'gone')).toEqual({
        stageId: 'gone',
        assetsRemoved: 1,
        blobsReleased: 1,
      });
      await pool.query('COMMIT');

      const rows = async (sql: string) => (await pool.query(sql)).rows;
      expect(await rows('SELECT id FROM document_scenes ORDER BY stage_id')).toEqual([
        { id: 's1' },
      ]);
      expect(await rows('SELECT stage_id FROM stage_meta WHERE deleted_at IS NOT NULL')).toEqual([
        { stage_id: 'gone' },
      ]);
      expect(await rows('SELECT id FROM asset_entries')).toEqual([{ id: `ast_${'2'.repeat(26)}` }]);
      expect(
        await rows('SELECT content_hash FROM asset_blobs WHERE unreferenced_at IS NOT NULL'),
      ).toEqual([{ content_hash: `sha256-${'1'.repeat(64)}` }]);

      // The worker's asset collector, exactly as its schedule prepares it,
      // then reclaims the released blob as app_worker.
      const { createAssetCollector } = await import('@/lib/persistence/asset-collector-schedule');
      await pool.query(
        "UPDATE asset_blobs SET unreferenced_at = clock_timestamp() - interval '2 hours' WHERE unreferenced_at IS NOT NULL",
      );
      vi.stubEnv('AUTH_MODE', 'supabase');
      vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', 'supabase');
      vi.stubEnv('ASSET_S3_BUCKET', '');
      vi.stubEnv('ASSET_BYTE_BACKEND', '');
      await pool.query('SET ROLE app_worker');
      try {
        const collector = await createAssetCollector(pool as never, 60 * 60_000);
        expect(await collector.collect()).toBe(1);
      } finally {
        await pool.query('RESET ROLE');
        vi.unstubAllEnvs();
      }
      expect(await rows('SELECT content_hash FROM asset_blobs')).toEqual([
        { content_hash: `sha256-${'2'.repeat(64)}` },
      ]);
    } finally {
      await pool.query('ROLLBACK').catch(() => undefined);
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    }
  }, 300_000);
});
