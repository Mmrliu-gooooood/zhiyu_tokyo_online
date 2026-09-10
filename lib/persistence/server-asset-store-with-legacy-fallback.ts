import type { AssetMeta, AssetRef, BinaryBlob } from '@openmaic/dsl';
import type { AssetId } from '@openmaic/storage';
import type { AssetPoolStore } from '@/lib/media/asset-pool-config';

/**
 * Keep new persistent-mode assets server-owned while preserving read access to
 * assets created in the browser pool before server asset persistence existed.
 * A remote error is never treated as a miss: fallback is allowed only after
 * the authoritative server explicitly reports that the id does not exist.
 */
export class ServerAssetStoreWithLegacyFallback implements AssetPoolStore {
  constructor(
    readonly server: AssetPoolStore,
    readonly legacy: AssetPoolStore,
  ) {}

  put(data: BinaryBlob, meta?: AssetMeta): Promise<AssetRef> {
    return this.server.put(data, meta);
  }

  async resolve(ref: AssetRef): Promise<string | null> {
    return (await this.server.resolve(ref)) ?? this.legacy.resolve(ref);
  }

  async exists(ref: AssetRef): Promise<boolean> {
    if (await this.server.exists?.(ref)) return true;
    return (await this.legacy.exists?.(ref)) ?? false;
  }

  async replace(ref: AssetId, data: BinaryBlob, meta?: AssetMeta): Promise<void> {
    if (await this.server.exists?.(ref)) return this.server.replace(ref, data, meta);
    if (await this.legacy.exists?.(ref)) return this.legacy.replace(ref, data, meta);
    return this.server.replace(ref, data, meta);
  }

  async remove(ref: AssetRef): Promise<void> {
    const serverHasRef = (await this.server.exists?.(ref)) ?? false;
    const legacyHasRef = (await this.legacy.exists?.(ref)) ?? false;
    await Promise.all([
      ...(serverHasRef ? [this.server.remove(ref)] : []),
      ...(legacyHasRef ? [this.legacy.remove(ref)] : []),
    ]);
  }

  async invalidate(ref: AssetRef): Promise<void> {
    await Promise.all([this.server.invalidate(ref), this.legacy.invalidate(ref)]);
  }

  async release(ref: AssetRef): Promise<void> {
    await Promise.all([this.server.release(ref), this.legacy.release(ref)]);
  }

  async close(): Promise<void> {
    await Promise.all([this.server.close(), this.legacy.close()]);
  }
}
