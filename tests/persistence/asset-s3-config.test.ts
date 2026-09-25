import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ loadS3AssetByteStore: vi.fn() }));

vi.mock('@openmaic/storage/asset/s3-bytes', () => ({
  loadS3AssetByteStore: mocks.loadS3AssetByteStore,
}));

import { createAssetByteStore } from '@/lib/persistence/asset-byte-store';

const variables = [
  'ASSET_BYTE_BACKEND',
  'ASSET_S3_ENDPOINT',
  'ASSET_S3_REGION',
  'ASSET_S3_FORCE_PATH_STYLE',
  'ASSET_S3_ACCESS_KEY_ID',
  'ASSET_S3_SECRET_ACCESS_KEY',
] as const;

function clearAssetS3Environment(): void {
  for (const variable of variables) vi.stubEnv(variable, '');
}

afterEach(() => {
  mocks.loadS3AssetByteStore.mockReset();
  vi.unstubAllEnvs();
});

describe('createAssetByteStore S3 client configuration', () => {
  it('injects application-specific S3 settings into the existing store loader', async () => {
    clearAssetS3Environment();
    vi.stubEnv('ASSET_S3_ENDPOINT', 'https://project-ref.storage.supabase.co/storage/v1/s3');
    vi.stubEnv('ASSET_S3_REGION', 'ap-southeast-1');
    vi.stubEnv('ASSET_S3_ACCESS_KEY_ID', 'test-access');
    vi.stubEnv('ASSET_S3_SECRET_ACCESS_KEY', 'test-secret');
    mocks.loadS3AssetByteStore.mockResolvedValue({ kind: 's3' });

    await createAssetByteStore('asset-bucket', { query: vi.fn() } as never);

    expect(mocks.loadS3AssetByteStore).toHaveBeenCalledExactlyOnceWith('asset-bucket', {
      endpoint: 'https://project-ref.storage.supabase.co/storage/v1/s3',
      region: 'ap-southeast-1',
      forcePathStyle: true,
      credentials: { accessKeyId: 'test-access', secretAccessKey: 'test-secret' },
    });
  });

  it('keeps the loader call compatible with the standard AWS SDK chain', async () => {
    clearAssetS3Environment();
    mocks.loadS3AssetByteStore.mockResolvedValue({ kind: 's3' });

    await createAssetByteStore('asset-bucket', { query: vi.fn() } as never);

    expect(mocks.loadS3AssetByteStore).toHaveBeenCalledExactlyOnceWith('asset-bucket');
  });
});
