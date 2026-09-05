import type { AssetPrincipal } from '@openmaic/storage';
import type { PgAssetStore } from '@openmaic/storage/asset/pg';

/** Signed owners may still read historical shared assets; writes stay private. */
export function withLegacySharedAssetReads(store: PgAssetStore): PgAssetStore {
  if (process.env.GENERATION_BACKGROUND_ENABLED !== '1') return store;
  return new Proxy(store, {
    get(target, key, receiver) {
      const original: unknown = Reflect.get(target, key, receiver);
      if (typeof original !== 'function') return original;
      if (!['resolve', 'identify', 'resolveIndirect'].includes(String(key)))
        return original.bind(target);
      return async (principal: AssetPrincipal, ...args: unknown[]) => {
        const result = await Reflect.apply(original, target, [principal, ...args]);
        if (result !== null || !principal.key.startsWith('anon:')) return result;
        return Reflect.apply(original, target, [{ key: 'shared' }, ...args]);
      };
    },
  });
}
