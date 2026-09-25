import { BrowserAssetStore } from '@openmaic/storage';

import type { AssetPoolStore } from './asset-pool-config';

export const ASSET_POOL_DATABASE_NAME = 'maic-asset-pool';

/** The single construction boundary for the browser's IndexedDB asset pool. */
export function createBrowserAssetPoolStore(): AssetPoolStore {
  return new BrowserAssetStore({ dbName: ASSET_POOL_DATABASE_NAME });
}
