import type { AssetByteStore } from '@openmaic/storage/asset/pg';

export type AssetByteStoreFactory = () => Promise<AssetByteStore>;

/**
 * Snapshot concrete file-backend selection outside the provider-neutral seam.
 * The returned factory keeps construction lazy while preventing environment
 * changes from making a wrapper advertise capabilities for a different store.
 */
export function configuredFileAssetByteStoreFactory(): AssetByteStoreFactory | undefined {
  if (process.env.ASSET_BYTE_BACKEND !== 'local') return undefined;
  return async () => {
    const { LocalAssetByteStore, resolveLocalAssetRoot } = await import('./local-asset-byte-store');
    return new LocalAssetByteStore(resolveLocalAssetRoot());
  };
}
