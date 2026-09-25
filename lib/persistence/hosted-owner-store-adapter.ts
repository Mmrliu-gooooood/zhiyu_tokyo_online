import { PgAssetStore } from '@openmaic/storage/asset/pg';
import { PgRuntimeStore } from '@openmaic/storage/runtime/pg';
import type { Pool } from 'pg';

import { createOwnerBoundQueryable } from '@/lib/db/request-queryable';
import { lazyAssetByteStore } from '@/lib/persistence/asset-byte-store';
import { hostedAssetBlobMutations } from '@/lib/persistence/hosted-asset-blob-mutations';
import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';

/**
 * Per-request stores for hosted auth. These concrete adapters must not be
 * cached across requests because each queryable binds one owner identity.
 */
export function createHostedOwnerBoundStores(pool: Pool, ownerId: string) {
  const queryable = createOwnerBoundQueryable(pool, ownerId);
  const byteStore = lazyAssetByteStore(process.env.ASSET_S3_BUCKET, queryable);
  return {
    queryable,
    runtimeStore: new PgRuntimeStore(queryable, {
      withTransaction: queryable.withTransaction,
      payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
    }),
    assetStore: new PgAssetStore(queryable, {
      withTransaction: queryable.withTransaction,
      byteStore,
      blobMutations: hostedAssetBlobMutations,
    }),
  };
}
