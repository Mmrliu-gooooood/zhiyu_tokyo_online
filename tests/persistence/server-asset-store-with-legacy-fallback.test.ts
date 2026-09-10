import { describe, expect, it, vi } from 'vitest';
import { toAssetId } from '@openmaic/storage';
import type { AssetPoolStore } from '@/lib/media/asset-pool-config';
import { ServerAssetStoreWithLegacyFallback } from '@/lib/persistence/server-asset-store-with-legacy-fallback';

function store(overrides: Partial<AssetPoolStore> = {}): AssetPoolStore {
  return {
    put: vi.fn(async () => 'ast_new'),
    resolve: vi.fn(async () => null),
    invalidate: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    replace: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    exists: vi.fn(async () => false),
    close: vi.fn(async () => undefined),
    ...overrides,
  } as AssetPoolStore;
}

describe('ServerAssetStoreWithLegacyFallback', () => {
  it('writes new assets only to the server store', async () => {
    const server = store();
    const legacy = store();
    const subject = new ServerAssetStoreWithLegacyFallback(server, legacy);
    const blob = new Blob(['new']);

    await expect(subject.put(blob)).resolves.toBe('ast_new');
    expect(server.put).toHaveBeenCalledWith(blob, undefined);
    expect(legacy.put).not.toHaveBeenCalled();
  });

  it('reads the legacy browser pool only after a confirmed server miss', async () => {
    const server = store({ resolve: vi.fn(async () => null) });
    const legacy = store({ resolve: vi.fn(async () => 'blob:legacy') });
    const subject = new ServerAssetStoreWithLegacyFallback(server, legacy);

    await expect(subject.resolve('ast_legacy')).resolves.toBe('blob:legacy');
    expect(server.resolve).toHaveBeenCalledBefore(legacy.resolve as ReturnType<typeof vi.fn>);
  });

  it('does not hide a server network or authorization failure with stale local bytes', async () => {
    const failure = new Error('HTTP_REQUEST_FAILED');
    const server = store({ resolve: vi.fn(async () => Promise.reject(failure)) });
    const legacy = store({ resolve: vi.fn(async () => 'blob:legacy') });
    const subject = new ServerAssetStoreWithLegacyFallback(server, legacy);

    await expect(subject.resolve('ast_shared')).rejects.toBe(failure);
    expect(legacy.resolve).not.toHaveBeenCalled();
  });

  it('updates a legacy-only id in place without allocating a replacement id', async () => {
    const server = store({ exists: vi.fn(async () => false) });
    const legacy = store({ exists: vi.fn(async () => true) });
    const subject = new ServerAssetStoreWithLegacyFallback(server, legacy);
    const blob = new Blob(['replacement']);

    const ref = toAssetId('ast_legacy');
    await subject.replace(ref, blob);
    expect(legacy.replace).toHaveBeenCalledWith(ref, blob, undefined);
    expect(server.replace).not.toHaveBeenCalled();
  });
});
