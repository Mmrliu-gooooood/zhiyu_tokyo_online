import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assertMigrationArgs,
  canReuseVerifiedObject,
  copyObject,
  migrateFilesystemObjects,
  remapRuntimeSessionLearner,
  sortAgentSessionEntriesParentFirst,
} from '../../scripts/migrate-supabase-storage.mjs';

type QueryResult<Row extends Record<string, unknown> = Record<string, unknown>> = {
  rows: Row[];
};

function poolFor(db: PGlite) {
  const query = async <Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<Row>> => db.query<Row>(sql, params) as Promise<QueryResult<Row>>;
  return {
    query,
    connect: async () => ({ query, release() {} }),
    end: async () => db.close(),
  };
}

class MemoryS3 {
  readonly objects = new Map<string, Buffer>();
  readonly commands: Array<'get' | 'put'> = [];

  async send(command: GetObjectCommand | PutObjectCommand) {
    const bucket = String(command.input.Bucket);
    const key = String(command.input.Key);
    const ref = `${bucket}/${key}`;
    if (command instanceof GetObjectCommand) {
      this.commands.push('get');
      const bytes = this.objects.get(ref);
      if (!bytes) {
        throw Object.assign(new Error('missing'), {
          name: 'NoSuchKey',
          $metadata: { httpStatusCode: 404 },
        });
      }
      return {
        Body: { transformToByteArray: async () => Uint8Array.from(bytes) },
      };
    }
    this.commands.push('put');
    this.objects.set(ref, Buffer.from(command.input.Body as Uint8Array));
    return {};
  }
}

async function migrationDb() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE storage_migration_objects (
      run_id text NOT NULL,
      source_kind text NOT NULL,
      source_key text NOT NULL,
      target_bucket text NOT NULL,
      target_key text NOT NULL,
      byte_size bigint NOT NULL,
      sha256 text NOT NULL,
      status text NOT NULL,
      last_error text,
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (run_id, source_kind, source_key)
    );
  `);
  return { db, pool: poolFor(db) };
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('storage migration safety', () => {
  it.each(['teachBack', 'chat', 'quizAttempt'])(
    'maps the %s learner column and JSON together without rewriting history',
    (kind) => {
      const source = {
        id: 'legacy-session-id',
        stage_id: 'legacy-stage',
        learner_key: 'anon:legacy-learner',
        data: {
          id: 'legacy-session-id',
          stageId: 'legacy-stage',
          learnerKey: 'anon:legacy-learner',
          kind,
          status: 'completed',
          metadata: { retained: true },
        },
      };
      const migrated = remapRuntimeSessionLearner(source, 'user:migration-admin');
      expect(migrated).toEqual({
        ...source,
        learner_key: 'user:migration-admin',
        data: { ...source.data, learnerKey: 'user:migration-admin' },
      });
      expect(source.learner_key).toBe('anon:legacy-learner');
      expect(source.data.learnerKey).toBe('anon:legacy-learner');
      expect(remapRuntimeSessionLearner(migrated, 'user:migration-admin')).toEqual(migrated);
    },
  );

  it('preserves a signed learner and refuses reassignment or mismatched source JSON', () => {
    const signed = { learner_key: 'user:original', data: { learnerKey: 'user:original' } };
    expect(remapRuntimeSessionLearner(signed, 'user:original')).toEqual(signed);
    expect(() => remapRuntimeSessionLearner(signed, 'user:admin')).toThrow(/signed-user/);
    expect(() =>
      remapRuntimeSessionLearner({ ...signed, learner_key: 'anon:legacy' }, 'user:admin'),
    ).toThrow(/disagree/);
  });

  it('reuses only an exact verified object ledger entry for the same run manifest', () => {
    const row = {
      source_key: 'sha256-abcd',
      target_bucket: 'assets',
      target_key: 'sha256-abcd',
      byte_size: '12',
      sha256: 'abcd',
      status: 'verified',
    };
    const expected = {
      sourceKey: 'sha256-abcd',
      bucket: 'assets',
      key: 'sha256-abcd',
      byteSize: 12,
      sha256: 'abcd',
    };
    expect(canReuseVerifiedObject(row, expected)).toBe(true);
    expect(canReuseVerifiedObject({ ...row, status: 'copied' }, expected)).toBe(false);
    expect(canReuseVerifiedObject({ ...row, byte_size: '13' }, expected)).toBe(false);
    expect(canReuseVerifiedObject({ ...row, target_key: 'other' }, expected)).toBe(false);
    expect(canReuseVerifiedObject({ ...row, sha256: 'different' }, expected)).toBe(false);
  });

  it('orders agent session entries parent-first with deterministic sibling ordering', () => {
    const rows = [
      { session_id: 's2', entry_id: 'z', parent_id: null },
      { session_id: 's1', entry_id: 'child-b', parent_id: 'root' },
      { session_id: 's1', entry_id: 'root', parent_id: null },
      { session_id: 's1', entry_id: 'child-a', parent_id: 'root' },
    ];

    expect(
      sortAgentSessionEntriesParentFirst(rows).map((row) => [row.session_id, row.entry_id]),
    ).toEqual([
      ['s1', 'root'],
      ['s1', 'child-a'],
      ['s1', 'child-b'],
      ['s2', 'z'],
    ]);
  });

  it('fails closed for missing parents and cycles', () => {
    expect(() =>
      sortAgentSessionEntriesParentFirst([
        { session_id: 's1', entry_id: 'child', parent_id: 'missing' },
      ]),
    ).toThrow(/missing parent/i);
    expect(() =>
      sortAgentSessionEntriesParentFirst([
        { session_id: 's1', entry_id: 'a', parent_id: 'b' },
        { session_id: 's1', entry_id: 'b', parent_id: 'a' },
      ]),
    ).toThrow(/cycle/i);
  });

  it('reuses a byte-identical destination object after a full read', async () => {
    const { db, pool } = await migrationDb();
    const s3 = new MemoryS3();
    const bytes = Buffer.from('same bytes');
    s3.objects.set('bucket/key', bytes);
    try {
      await copyObject(s3 as never, pool as never, 'run', 'kind', 'source', 'bucket', 'key', bytes);
      expect(s3.commands).toEqual(['get']);
      const result = await db.query<{ status: string }>(
        'SELECT status FROM storage_migration_objects',
      );
      expect(result.rows).toEqual([{ status: 'verified' }]);
    } finally {
      await db.close();
    }
  });

  it('fails on a conflicting destination object without overwriting it', async () => {
    const { db, pool } = await migrationDb();
    const s3 = new MemoryS3();
    s3.objects.set('bucket/key', Buffer.from('hosted data'));
    try {
      await expect(
        copyObject(
          s3 as never,
          pool as never,
          'run',
          'kind',
          'source',
          'bucket',
          'key',
          Buffer.from('legacy data'),
        ),
      ).rejects.toThrow(/destination object conflict/i);
      expect(s3.commands).toEqual(['get']);
      expect(s3.objects.get('bucket/key')?.toString()).toBe('hosted data');
    } finally {
      await db.close();
    }
  });

  it('fully reads back a newly uploaded object', async () => {
    const { db, pool } = await migrationDb();
    const s3 = new MemoryS3();
    const bytes = Buffer.from('new bytes');
    try {
      await copyObject(s3 as never, pool as never, 'run', 'kind', 'source', 'bucket', 'key', bytes);
      expect(s3.commands).toEqual(['get', 'put', 'get']);
    } finally {
      await db.close();
    }
  });

  it('rejects the retired object-readback escape hatch', () => {
    expect(() => assertMigrationArgs(['--apply', '--skip-object-readback'])).toThrow(
      /skip-object-readback.*not supported/i,
    );
  });

  it('publishes owner-rewritten snapshots and hosted classroom media mappings idempotently', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'openmaic-storage-migration-test-'));
    temporaryDirectories.push(root);
    const classroomRoot = path.join(root, 'classrooms');
    await mkdir(path.join(classroomRoot, 'course-1', 'media'), { recursive: true });
    await writeFile(
      path.join(classroomRoot, 'course-1.json'),
      JSON.stringify({
        id: 'course-1',
        stage: { id: 'stage-1', title: 'Legacy' },
        scenes: [],
        createdAt: '2026-01-02T03:04:05.000Z',
        ownerId: 'anon:legacy',
      }),
    );
    const mediaBytes = Buffer.from('png bytes');
    await writeFile(path.join(classroomRoot, 'course-1', 'media', 'cover.png'), mediaBytes);

    const { db, pool } = await migrationDb();
    const ownerId = 'user:00000000-0000-4000-8000-000000000001';
    await db.exec(`
      CREATE TABLE app_accounts (owner_id text PRIMARY KEY);
      INSERT INTO app_accounts(owner_id) VALUES ('${ownerId}');
      CREATE TABLE classroom_snapshots (
        classroom_id text PRIMARY KEY,
        owner_id text NOT NULL REFERENCES app_accounts(owner_id),
        stage_id text,
        storage_ref text,
        version bigint NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      CREATE TABLE asset_blobs (
        content_hash text PRIMARY KEY,
        byte_size bigint NOT NULL,
        bytes bytea,
        unreferenced_at timestamptz
      );
      CREATE TABLE asset_entries (
        id text PRIMARY KEY,
        principal text NOT NULL,
        content_hash text NOT NULL REFERENCES asset_blobs(content_hash),
        mime text NOT NULL,
        meta jsonb NOT NULL,
        revision integer NOT NULL DEFAULT 1,
        created_at double precision NOT NULL
      );
      CREATE TABLE classroom_media_objects (
        owner_id text NOT NULL REFERENCES app_accounts(owner_id),
        classroom_id text NOT NULL,
        legacy_path text NOT NULL,
        asset_id text NOT NULL REFERENCES asset_entries(id) ON DELETE RESTRICT,
        mime text,
        byte_size bigint,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY(owner_id, classroom_id, legacy_path)
      );
    `);
    const s3 = new MemoryS3();
    const buckets = { assets: 'assets', materials: 'materials', classrooms: 'classrooms' };
    try {
      await migrateFilesystemObjects(s3 as never, pool as never, 'run', root, buckets, ownerId);
      await migrateFilesystemObjects(s3 as never, pool as never, 'run', root, buckets, ownerId);

      const snapshots = await db.query<{
        classroom_id: string;
        owner_id: string;
        stage_id: string;
        storage_ref: string;
        version: string;
      }>(
        'SELECT classroom_id,owner_id,stage_id,storage_ref,version::text FROM classroom_snapshots',
      );
      expect(snapshots.rows).toHaveLength(1);
      expect(snapshots.rows[0]).toMatchObject({
        classroom_id: 'course-1',
        owner_id: ownerId,
        stage_id: 'stage-1',
        version: '1',
      });
      const snapshotKey = snapshots.rows[0]!.storage_ref.replace('s3://classrooms/', '');
      expect(snapshotKey).toMatch(
        /^snapshots\/user%3A00000000-0000-4000-8000-000000000001\/course-1\/1-[a-f0-9]{64}\.json$/,
      );
      expect(JSON.parse(s3.objects.get(`classrooms/${snapshotKey}`)!.toString())).toMatchObject({
        id: 'course-1',
        ownerId,
      });

      const mappings = await db.query<{
        legacy_path: string;
        principal: string;
        content_hash: string;
        mime: string;
        byte_size: string;
        asset_id: string;
      }>(`
        SELECT m.legacy_path,e.principal,e.content_hash,e.mime,m.byte_size::text,e.id AS asset_id
          FROM classroom_media_objects m JOIN asset_entries e ON e.id=m.asset_id
      `);
      const mediaHash = `sha256-${createHash('sha256').update(mediaBytes).digest('hex')}`;
      expect(mappings.rows).toEqual([
        {
          legacy_path: 'media/cover.png',
          principal: ownerId,
          content_hash: mediaHash,
          mime: 'image/png',
          byte_size: String(mediaBytes.byteLength),
          asset_id: expect.stringMatching(/^ast_[0-9a-z]+$/),
        },
      ]);
      expect(s3.objects.get(`assets/${mediaHash}`)).toEqual(mediaBytes);
      expect(s3.commands.filter((command) => command === 'put')).toHaveLength(2);
    } finally {
      await db.close();
    }
  });
});
