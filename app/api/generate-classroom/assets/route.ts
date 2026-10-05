import { createHash } from 'node:crypto';
import { PgAssetStore } from '@openmaic/storage/asset/pg';
import { lazyAssetByteStore } from '@/lib/persistence/asset-byte-store';
import { hostedAssetBlobMutations } from '@/lib/persistence/hosted-asset-blob-mutations';
import {
  generationResponse,
  readBoundedBody,
  withGenerationRequest,
} from '@/lib/server/generation-jobs/http';
import { GenerationJobError } from '@/lib/server/generation-jobs/contracts';
export const dynamic = 'force-dynamic';
export async function POST(req: Request) {
  return withGenerationRequest(
    req,
    async ({ ownerId, headers, queryable }) => {
      const bytes = await readBoundedBody(req, 30_000_000);
      if (!bytes.length) throw new GenerationJobError('EMPTY_ASSET', 400);
      const mime = req.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream';
      const name = decodeURIComponent(req.headers.get('x-asset-name') ?? 'material').slice(0, 500);
      const digest = createHash('sha256').update(bytes).digest('hex');
      const uploaded = await queryable.withTransaction(async (transaction) => {
        await transaction.query(
          "SELECT pg_advisory_xact_lock(hashtext('generation:upload:' || $1 || ':' || $2))",
          [ownerId, digest],
        );
        // The registry keys blobs as `sha256-<hex>`; the response keeps the bare digest.
        const existing = await transaction.query<{ id: string; revision: number }>(
          'SELECT id,revision FROM asset_entries WHERE principal=$1 AND content_hash=$2 ORDER BY id LIMIT 1',
          [ownerId, `sha256-${digest}`],
        );
        if (existing.rows[0])
          return { assetId: existing.rows[0].id, revision: existing.rows[0].revision };
        const store = new PgAssetStore(transaction, {
          withTransaction: (body) => body(transaction),
          byteStore: lazyAssetByteStore(process.env.ASSET_S3_BUCKET, transaction),
          blobMutations: hostedAssetBlobMutations,
          quotaBytes: 300_000_000,
        });
        const assetId = await store.put(
          { key: ownerId },
          new Blob([bytes as BlobPart], { type: mime }),
          { contentType: mime, filename: name },
        );
        return { assetId, revision: 1 };
      });
      return generationResponse({ success: true, ...uploaded, digest }, headers, 201);
    },
    { createSession: true, submitting: true },
  );
}
