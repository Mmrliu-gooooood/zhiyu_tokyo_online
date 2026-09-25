import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { AssetStore, Queryable } from '@openmaic/storage/asset/pg';

import { isHostedAuthEnabled } from '@/lib/auth/mode';
import { getPersistencePool } from '@/lib/db/pool-registry';
import { lazyAssetByteStore } from '@/lib/persistence/asset-byte-store';
import { createHostedOwnerBoundStores } from '@/lib/persistence/server-provider';
import { CLASSROOMS_DIR } from '@/lib/server/classroom-storage';
import { getHeavyTaskRootContext } from '@/lib/server/heavy-task-admission';

function extensionForMime(mime: string): string {
  const known: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/ogg': 'ogg',
  };
  return known[mime] ?? 'bin';
}

export interface ClassroomMediaAsset {
  bytes: Uint8Array;
  mime: string;
  byteSize: number;
}

export interface ClassroomMediaIdentity {
  assetId: string;
  contentHash: string;
  mime: string;
  byteSize: number;
}

interface HostedClassroomMediaStores {
  queryable: Queryable;
  assetStore: AssetStore;
}

function hostedOwnerId(explicitOwnerId?: string): string {
  const ownerId = explicitOwnerId ?? getHeavyTaskRootContext()?.ownerId;
  if (!ownerId) throw new Error('HOSTED_CLASSROOM_OWNER_REQUIRED');
  return ownerId;
}

function hostedStores(ownerId: string): HostedClassroomMediaStores {
  return createHostedOwnerBoundStores(getPersistencePool(), ownerId);
}

function validateLegacyPath(classroomId: string, legacyPath: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(classroomId)) throw new Error('INVALID_CLASSROOM_ID');
  const parts = legacyPath.split('/');
  if (
    parts.length !== 2 ||
    (parts[0] !== 'media' && parts[0] !== 'audio') ||
    !parts[1] ||
    parts.some((part) => part === '.' || part === '..' || part.includes('\0'))
  ) {
    throw new Error('INVALID_CLASSROOM_MEDIA_PATH');
  }
}

/**
 * Allocate bytes in the owner-bound asset registry, then publish the stable
 * legacy classroom URL mapping. The registry write happens first so a mapping
 * can never point at missing bytes. If publishing fails, the fresh entry is
 * retired immediately; its content-addressed object is reclaimed by the
 * normal asset collector once no other entry references it.
 */
export async function persistHostedClassroomMediaObject(
  input: {
    ownerId: string;
    classroomId: string;
    legacyPath: string;
    bytes: Buffer | Uint8Array;
    mime: string;
    signal?: AbortSignal;
  },
  stores: HostedClassroomMediaStores = hostedStores(input.ownerId),
): Promise<void> {
  validateLegacyPath(input.classroomId, input.legacyPath);
  if (input.signal?.aborted) throw new Error('aborted');
  const principal = { key: input.ownerId };
  const existing = await stores.queryable.query<{ asset_id: string }>(
    `SELECT asset_id
       FROM classroom_media_objects
      WHERE owner_id=$1 AND classroom_id=$2 AND legacy_path=$3`,
    [input.ownerId, input.classroomId, input.legacyPath],
  );
  if (input.signal?.aborted) throw new Error('aborted');
  const blob = new Blob([input.bytes as BlobPart], { type: input.mime });
  const existingAssetId = existing.rows[0]?.asset_id;
  if (existingAssetId) {
    await stores.assetStore.replace(principal, existingAssetId as never, blob, {
      contentType: input.mime,
    });
    await stores.queryable.query(
      `UPDATE classroom_media_objects
          SET mime=$4, byte_size=$5, updated_at=clock_timestamp()
        WHERE owner_id=$1 AND classroom_id=$2 AND legacy_path=$3`,
      [input.ownerId, input.classroomId, input.legacyPath, input.mime, input.bytes.byteLength],
    );
    return;
  }

  const assetId = await stores.assetStore.put(principal, blob, { contentType: input.mime });
  let published = false;
  try {
    if (input.signal?.aborted) throw new Error('aborted');
    const inserted = await stores.queryable.query<{ asset_id: string }>(
      `INSERT INTO classroom_media_objects
         (owner_id, classroom_id, legacy_path, asset_id, mime, byte_size)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (owner_id, classroom_id, legacy_path) DO NOTHING
       RETURNING asset_id`,
      [
        input.ownerId,
        input.classroomId,
        input.legacyPath,
        assetId,
        input.mime,
        input.bytes.byteLength,
      ],
    );
    published = inserted.rows[0]?.asset_id === assetId;
    // A concurrent identical-path writer won. Its complete mapping is the
    // idempotent result; retire this redundant entry below.
    if (!published) {
      const winner = await stores.queryable.query<{ asset_id: string }>(
        `SELECT asset_id
           FROM classroom_media_objects
          WHERE owner_id=$1 AND classroom_id=$2 AND legacy_path=$3`,
        [input.ownerId, input.classroomId, input.legacyPath],
      );
      if (!winner.rows[0]) throw new Error('CLASSROOM_MEDIA_MAPPING_CONFLICT');
    }
  } catch (error) {
    try {
      await stores.assetStore.remove(principal, assetId);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'CLASSROOM_MEDIA_MAPPING_FAILED_AND_ASSET_CLEANUP_FAILED',
      );
    }
    throw error;
  }
  if (!published) await stores.assetStore.remove(principal, assetId);
}

/** Identify one stable classroom URL without reading its potentially large bytes. */
export async function identifyHostedClassroomMediaObject(
  input: { ownerId: string; classroomId: string; legacyPath: string },
  stores: HostedClassroomMediaStores = hostedStores(input.ownerId),
): Promise<ClassroomMediaIdentity | null> {
  validateLegacyPath(input.classroomId, input.legacyPath);
  const mapping = await stores.queryable.query<{
    asset_id: string;
    content_hash: string;
    mime: string;
    byte_size: string | number;
  }>(
    `SELECT m.asset_id, e.content_hash, e.mime, b.byte_size
       FROM classroom_media_objects m
       JOIN asset_entries e ON e.id=m.asset_id AND e.principal=m.owner_id
       JOIN asset_blobs b ON b.content_hash=e.content_hash
      WHERE m.owner_id=$1 AND m.classroom_id=$2 AND m.legacy_path=$3`,
    [input.ownerId, input.classroomId, input.legacyPath],
  );
  const row = mapping.rows[0];
  return row
    ? {
        assetId: row.asset_id,
        contentHash: row.content_hash,
        mime: row.mime,
        byteSize: Number(row.byte_size),
      }
    : null;
}

/** Resolve one stable classroom URL through an owner-bound mapping. */
export async function resolveHostedClassroomMediaObject(
  input: {
    ownerId: string;
    classroomId: string;
    legacyPath: string;
    range?: { start: number; end: number };
    identity?: ClassroomMediaIdentity;
  },
  stores: HostedClassroomMediaStores = hostedStores(input.ownerId),
): Promise<ClassroomMediaAsset | null> {
  const identity = input.identity ?? (await identifyHostedClassroomMediaObject(input, stores));
  if (!identity) return null;
  if (input.range) {
    const byteStore = lazyAssetByteStore(process.env.ASSET_S3_BUCKET, stores.queryable);
    if (typeof byteStore.readRange === 'function') {
      const bytes = await byteStore.readRange(
        identity.contentHash as never,
        input.range.start,
        input.range.end,
      );
      return bytes ? { bytes, mime: identity.mime, byteSize: identity.byteSize } : null;
    }
  }
  const resolved = await stores.assetStore.resolve({ key: input.ownerId }, identity.assetId);
  if (!resolved) return null;
  const bytes = input.range
    ? resolved.bytes.slice(input.range.start, input.range.end + 1)
    : resolved.bytes;
  return { bytes, mime: resolved.mime, byteSize: identity.byteSize };
}

/**
 * Persist raw media bytes under the stage's classroom-media path and return
 * an origin-independent serving reference.
 *
 * The returned reference is a RELATIVE path (`/api/classroom-media/...`), not
 * an absolute URL. This is the agent runtime's only byte-persist path: it runs
 * with no HTTP request to derive an origin from, and the durable value must
 * stay valid regardless of which origin serves the app. The browser resolves
 * the relative path against the page origin (image/video `src`, narration
 * `audioUrl` playback), and every server-side consumer of the reference reads
 * the local file or fetches it relative to the same origin. Request-bearing
 * routes that DO have an origin build absolute URLs through
 * `resolveMediaServingOrigin` (`classroom-media-generation.ts`).
 */
export async function persistClassroomMediaBytes(input: {
  stageId: string;
  bytes: Buffer | Uint8Array;
  mime: string;
  prefix?: string;
  filename?: string;
  subdir?: 'media' | 'audio';
  ownerId?: string;
  signal?: AbortSignal;
}): Promise<string> {
  if (input.signal?.aborted) throw new Error('aborted');
  const hash = createHash('sha256').update(input.bytes).digest('hex');
  const filename =
    input.filename ?? `${input.prefix ?? 'generated'}-${hash}.${extensionForMime(input.mime)}`;
  if (filename.includes('/') || filename.includes('\\') || filename.includes('\0')) {
    throw new Error('INVALID_CLASSROOM_MEDIA_FILENAME');
  }
  const subdir = input.subdir ?? 'media';
  const legacyPath = `${subdir}/${filename}`;
  if (isHostedAuthEnabled()) {
    const ownerId = hostedOwnerId(input.ownerId);
    await persistHostedClassroomMediaObject({
      ownerId,
      classroomId: input.stageId,
      legacyPath,
      bytes: input.bytes,
      mime: input.mime,
      signal: input.signal,
    });
    return `/api/classroom-media/${input.stageId}/${legacyPath}`;
  }

  const mediaDir = path.join(CLASSROOMS_DIR, input.stageId, subdir);
  await fs.mkdir(mediaDir, { recursive: true });
  if (input.signal?.aborted) throw new Error('aborted');
  await fs.writeFile(path.join(mediaDir, filename), input.bytes);
  return `/api/classroom-media/${input.stageId}/${legacyPath}`;
}
