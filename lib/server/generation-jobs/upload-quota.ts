/**
 * Per-account quota for course materials uploaded to generation.
 *
 * It bounds what a user uploads (PDFs, images handed to a generation job),
 * not what generation produces: narration audio and generated images are the
 * account's course content and never count here. Uploads are tagged in the
 * asset metadata so the sum covers exactly them; uploads made before the tag
 * existed are not counted.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import { GenerationJobError } from './contracts';

export const GENERATION_UPLOAD_QUOTA_BYTES = 300_000_000;
export const GENERATION_UPLOAD_ORIGIN = 'generation-upload';

/** Bytes of generation uploads the owner currently holds. */
export async function generationUploadBytes(q: Queryable, ownerId: string): Promise<number> {
  const result = await q.query<{ used: string }>(
    `SELECT COALESCE(SUM(blob.byte_size), 0)::text AS used
       FROM asset_entries entry
       JOIN asset_blobs blob ON blob.content_hash = entry.content_hash
      WHERE entry.principal = $1 AND entry.meta->>'origin' = $2`,
    [ownerId, GENERATION_UPLOAD_ORIGIN],
  );
  return Number(result.rows[0]?.used ?? 0);
}

/**
 * Serialize the owner's uploads and refuse one that would exceed the quota.
 * Call inside the transaction that stores the upload.
 */
export async function assertGenerationUploadQuota(
  q: Queryable,
  ownerId: string,
  addedBytes: number,
  quotaBytes = GENERATION_UPLOAD_QUOTA_BYTES,
): Promise<void> {
  await q.query("SELECT pg_advisory_xact_lock(hashtext('generation:upload-quota:' || $1))", [
    ownerId,
  ]);
  if ((await generationUploadBytes(q, ownerId)) + addedBytes > quotaBytes) {
    throw new GenerationJobError('ASSET_QUOTA_EXCEEDED', 413);
  }
}
