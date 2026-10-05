/**
 * The owner-library upload pipeline shared by `POST /api/materials` (workbench)
 * and `POST /api/study/materials` (study material library, learning plan B02).
 *
 * One upload = one owner_material row plus one private byte-store object:
 * reclaim crashed reservations older than 24 hours (bytes first, then the
 * row), reserve a quota-checked `uploading` row, stream the body through a
 * size cap, store the bytes and finalize the row with its SHA-256. Every
 * failure after the reservation removes the reservation (and the bytes when
 * they were stored); crash leftovers are reclaimed by a later upload.
 *
 * Callers own MIME policy, response shapes and logging; this module only
 * reports a typed rejection or the finalized record, and keeps `state`
 * updated so the caller's log lines carry the phase and sizes.
 */
import { createHash } from 'node:crypto';
import { basename } from 'node:path';

import { createMaterialId } from '@openmaic/storage';

import {
  abandonOwnerMaterial,
  finalizeOwnerMaterial,
  MaterialQuotaExceededError,
  reclaimStaleOwnerMaterialUploads,
  registerOwnerMaterial,
  type OwnerMaterialRecord,
} from '@/lib/persistence/owner-materials';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { createOwnerBoundQueryable } from '@/lib/db/request-queryable';
import { getMaterialByteStore } from '@/lib/server/materials/bytes';
import { agentRuntimeConfig } from '@/lib/server/agent-runtime/config';

/** A client-correctable upload rejection (never a server fault). */
export class OwnerUploadRejected extends Error {
  constructor(
    readonly status: number,
    readonly code: 'INVALID_REQUEST' | 'MISSING_REQUIRED_FIELD',
    message: string,
    /** Stable log reason, e.g. `quota_exceeded`. */
    readonly reason: string,
  ) {
    super(message);
    this.name = 'OwnerUploadRejected';
  }
}

class MaterialPayloadTooLarge extends Error {}

export interface OwnerUploadState {
  phase: string;
  materialId?: string;
  declaredBytes: number;
  receivedBytes: number;
  /** True once a stream failure was already logged by this module's caller path. */
  failureLogged: boolean;
}

export interface OwnerUploadOptions {
  /** Canonical MIME type (already normalized and accepted by the caller's policy). */
  mime: string;
  /** Per-file byte cap for this MIME class. */
  uploadLimit: number;
  state: OwnerUploadState;
  warn: (message: string, extra?: Record<string, unknown>, error?: unknown) => void;
}

/** The `x-material-filename` header, sanitized to a bare file name. */
export function materialUploadFilename(req: Request): string | null {
  const raw = req.headers.get('x-material-filename');
  if (!raw) return null;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Preserve a plain header value; malformed percent escapes are not paths.
  }
  const name = basename(decoded.replace(/\\/g, '/')).trim().slice(0, 512);
  return name || null;
}

/** Read the body up to `limit` bytes; throws {@link MaterialPayloadTooLarge} over the cap. */
async function readMeteredBody(req: Request, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = req.body!.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const buffer = Buffer.from(value);
    total += buffer.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new MaterialPayloadTooLarge();
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Store one uploaded file into the owner's material library and return its
 * finalized `ready` record. Throws {@link OwnerUploadRejected} for client
 * errors; any other error means the upload failed server-side (its
 * reservation and bytes were already cleaned up where confirmed).
 */
export async function storeOwnerMaterialUpload(
  req: Request,
  ownerId: string,
  options: OwnerUploadOptions,
): Promise<OwnerMaterialRecord> {
  const { mime, uploadLimit, state } = options;
  state.declaredBytes = Number(req.headers.get('content-length') ?? 0);
  if (Number.isFinite(state.declaredBytes) && state.declaredBytes > uploadLimit) {
    throw new OwnerUploadRejected(
      413,
      'INVALID_REQUEST',
      `upload exceeds ${uploadLimit} bytes`,
      'declared_body_too_large',
    );
  }
  if (!req.body) {
    throw new OwnerUploadRejected(400, 'INVALID_REQUEST', 'empty body', 'empty_body');
  }
  const originalName = materialUploadFilename(req);
  if (!originalName) {
    throw new OwnerUploadRejected(
      400,
      'MISSING_REQUIRED_FIELD',
      'x-material-filename header is required',
      'missing_filename',
    );
  }
  const createdMaterialId = createMaterialId();
  state.materialId = createdMaterialId;
  const ossKey = `materials/${ownerId}/${createdMaterialId}`;

  const provider = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  const ownerDb = createOwnerBoundQueryable(provider.pool, ownerId);
  const byteStore = getMaterialByteStore();

  // Browsers send Content-Length for a File body. When an intermediary
  // strips it, reserve the per-file maximum so an unmeasured stream can
  // never bypass the owner byte quota; finalize shrinks the reservation to
  // its actual size.
  const reservedBytes =
    Number.isFinite(state.declaredBytes) && state.declaredBytes > 0
      ? state.declaredBytes
      : uploadLimit;

  // Reclaim uploads that crashed before finalize and are older than the
  // 24-hour horizon. Each reservation's byte object is removed first; the
  // reservation is deleted only after that, so a failure here keeps the
  // reservation for the next pass instead of losing the pointer to its bytes.
  state.phase = 'reclaim_stale_uploads';
  await reclaimStaleOwnerMaterialUploads(ownerDb, ownerId, async (objectKey) => {
    try {
      await byteStore.delete(objectKey);
    } catch (error) {
      options.warn(
        'material stale byte deletion failed; keeping its reservation for the next pass',
        { objectKey },
        error,
      );
      throw error;
    }
  }).catch((error) => {
    options.warn('material stale-upload reclaim failed; retrying on the next upload', {}, error);
  });

  state.phase = 'reserve_material';
  try {
    await registerOwnerMaterial(
      ownerDb,
      {
        id: createdMaterialId,
        ownerId,
        kind: 'source',
        mime,
        bytes: reservedBytes,
        originalName,
        ossKey,
        extraction: { status: 'idle' },
      },
      {
        maxCount: agentRuntimeConfig.maxMaterialsPerOwner,
        maxTotalBytes: agentRuntimeConfig.maxMaterialBytesPerOwner,
      },
      ownerDb.withTransaction,
    );
  } catch (error) {
    if (error instanceof MaterialQuotaExceededError) {
      throw new OwnerUploadRejected(429, 'INVALID_REQUEST', error.message, 'quota_exceeded');
    }
    throw error;
  }

  state.phase = 'store_bytes';
  // Read the body through a size meter, enforcing the per-class cap on the
  // streamed size (an unmeasured stream cannot bypass the cap).
  let bytes: Buffer;
  try {
    bytes = await readMeteredBody(req, uploadLimit);
    state.receivedBytes = bytes.byteLength;
  } catch (error) {
    if (error instanceof MaterialPayloadTooLarge) {
      await abandonOwnerMaterial(ownerDb, createdMaterialId).catch(() => undefined);
      throw new OwnerUploadRejected(
        413,
        'INVALID_REQUEST',
        `upload exceeds ${uploadLimit} bytes`,
        'streamed_body_too_large',
      );
    }
    state.failureLogged = true;
    await abandonOwnerMaterial(ownerDb, createdMaterialId).catch(() => undefined);
    throw error;
  }
  if (bytes.byteLength === 0) {
    await abandonOwnerMaterial(ownerDb, createdMaterialId).catch(() => undefined);
    throw new OwnerUploadRejected(400, 'INVALID_REQUEST', 'empty body', 'empty_stream');
  }
  if (bytes.byteLength > reservedBytes) {
    await abandonOwnerMaterial(ownerDb, createdMaterialId).catch(() => undefined);
    throw new OwnerUploadRejected(
      413,
      'INVALID_REQUEST',
      'upload body exceeds its declared content length',
      'declared_length_mismatch',
    );
  }

  // The object key is recorded by the reservation before bytes are stored.
  // A crash after the write therefore leaves a durable pointer for the
  // 24-hour reclaim, preserving delete-before-reservation-removal order.
  const hash = createHash('sha256').update(bytes).digest('hex');
  let bytesStored = false;
  try {
    await byteStore.put(ossKey, bytes, mime);
    bytesStored = true;
    return await finalizeOwnerMaterial(ownerDb, createdMaterialId, bytes.byteLength, hash);
  } catch (error) {
    let bytesDeleted = !bytesStored;
    if (bytesStored) {
      try {
        await byteStore.delete(ossKey);
        bytesDeleted = true;
      } catch (cleanupError) {
        options.warn(
          'material byte cleanup failed; keeping its reservation for stale reclaim',
          { objectKey: ossKey },
          cleanupError,
        );
      }
    }
    if (bytesDeleted) {
      await abandonOwnerMaterial(ownerDb, createdMaterialId).catch(() => undefined);
    }
    throw error;
  }
}

/** Remove a finalized upload that its caller could not attach (bytes first, then the row). */
export async function discardOwnerMaterialUpload(
  ownerId: string,
  record: Pick<OwnerMaterialRecord, 'id' | 'ossKey'>,
): Promise<void> {
  const provider = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  const ownerDb = createOwnerBoundQueryable(provider.pool, ownerId);
  await getMaterialByteStore().delete(record.ossKey);
  await ownerDb.query('DELETE FROM owner_material WHERE id=$1 AND owner_id=$2', [
    record.id,
    ownerId,
  ]);
}
