import { PGlite } from '@electric-sql/pglite';
import { PgAssetByteStore } from '@openmaic/storage/asset/pg-bytes';
import {
  PgAssetStore,
  ensureAssetSchema,
  type Queryable,
  type WithTransaction,
} from '@openmaic/storage/asset/pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  persistHostedClassroomMediaObject,
  resolveHostedClassroomMediaObject,
} from '@/lib/server/classroom-media-bytes';

const OWNER_A = 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_B = 'user:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function transactions(db: PGlite): WithTransaction {
  return (body) => db.transaction((tx: Queryable) => body(tx));
}

describe('hosted classroom media asset mappings', () => {
  let db: PGlite;
  let assetStore: PgAssetStore;

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    await ensureAssetSchema(db);
    await db.exec(`
      CREATE TABLE classroom_media_objects (
        owner_id text NOT NULL,
        classroom_id text NOT NULL,
        legacy_path text NOT NULL,
        asset_id text NOT NULL REFERENCES asset_entries(id) ON DELETE RESTRICT,
        mime text,
        byte_size bigint,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (owner_id, classroom_id, legacy_path)
      )
    `);
    assetStore = new PgAssetStore(db, {
      withTransaction: transactions(db),
      byteStore: new PgAssetByteStore(db),
    });
  });

  afterEach(async () => {
    await db.close();
  });

  it('persists a real registry entry and resolves the mapping only for its owner', async () => {
    const stores = { queryable: db, assetStore };
    await persistHostedClassroomMediaObject(
      {
        ownerId: OWNER_A,
        classroomId: 'class-a',
        legacyPath: 'media/slide.png',
        bytes: Buffer.from('owner-a-image'),
        mime: 'image/png',
      },
      stores,
    );

    const mapping = await db.query<{ owner_id: string; principal: string; byte_size: number }>(`
      SELECT m.owner_id, e.principal, b.byte_size
        FROM classroom_media_objects m
        JOIN asset_entries e ON e.id=m.asset_id
        JOIN asset_blobs b ON b.content_hash=e.content_hash
    `);
    expect(mapping.rows).toEqual([
      expect.objectContaining({ owner_id: OWNER_A, principal: OWNER_A, byte_size: 13 }),
    ]);
    const own = await resolveHostedClassroomMediaObject(
      { ownerId: OWNER_A, classroomId: 'class-a', legacyPath: 'media/slide.png' },
      stores,
    );
    expect(Buffer.from(own!.bytes).toString()).toBe('owner-a-image');
    const range = await resolveHostedClassroomMediaObject(
      {
        ownerId: OWNER_A,
        classroomId: 'class-a',
        legacyPath: 'media/slide.png',
        range: { start: 6, end: 8 },
      },
      stores,
    );
    expect(Buffer.from(range!.bytes).toString()).toBe('a-i');
    await expect(
      resolveHostedClassroomMediaObject(
        { ownerId: OWNER_B, classroomId: 'class-a', legacyPath: 'media/slide.png' },
        stores,
      ),
    ).resolves.toBeNull();
  });

  it('replaces an idempotent legacy path without leaking another registry entry', async () => {
    const stores = { queryable: db, assetStore };
    const key = {
      ownerId: OWNER_A,
      classroomId: 'class-a',
      legacyPath: 'audio/line.mp3',
    };
    await persistHostedClassroomMediaObject(
      { ...key, bytes: Buffer.from('first'), mime: 'audio/mpeg' },
      stores,
    );
    await persistHostedClassroomMediaObject(
      { ...key, bytes: Buffer.from('second'), mime: 'audio/mpeg' },
      stores,
    );

    const counts = await db.query<{ mappings: number; entries: number }>(`
      SELECT
        (SELECT count(*)::int FROM classroom_media_objects) AS mappings,
        (SELECT count(*)::int FROM asset_entries) AS entries
    `);
    expect(counts.rows[0]).toEqual({ mappings: 1, entries: 1 });
    const resolved = await resolveHostedClassroomMediaObject(key, stores);
    expect(Buffer.from(resolved!.bytes).toString()).toBe('second');
  });

  it('retires a freshly allocated asset when publishing its mapping fails', async () => {
    const failingQueryable: Queryable = {
      query: async <TRow extends Record<string, unknown>>(sql: string, params?: unknown[]) => {
        if (/INSERT INTO classroom_media_objects/.test(sql)) throw new Error('mapping unavailable');
        return db.query<TRow>(sql, params);
      },
    };
    await expect(
      persistHostedClassroomMediaObject(
        {
          ownerId: OWNER_A,
          classroomId: 'class-a',
          legacyPath: 'media/failure.png',
          bytes: Buffer.from('doomed'),
          mime: 'image/png',
        },
        { queryable: failingQueryable, assetStore },
      ),
    ).rejects.toThrow('mapping unavailable');

    const entries = await db.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM asset_entries',
    );
    expect(entries.rows[0]?.count).toBe(0);
  });
});
