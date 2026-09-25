import type { AssetBlobMutations } from '@openmaic/storage/asset/pg';

/**
 * Hosted app_web has no direct blob INSERT/UPDATE grant. These calls reach
 * narrowly-scoped SECURITY DEFINER functions which validate the bound owner,
 * hash and size while keeping the registry transaction pinned.
 */
export const hostedAssetBlobMutations: AssetBlobMutations = {
  async claim(queryable, hash, byteSize) {
    await queryable.query('SELECT app_internal.claim_asset_blob($1, $2)', [hash, byteSize]);
  },
  async release(queryable, hash) {
    await queryable.query('SELECT app_internal.release_asset_blob($1)', [hash]);
  },
};
