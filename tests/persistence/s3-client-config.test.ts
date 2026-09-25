import { describe, expect, it } from 'vitest';

import { configuredAssetS3Client, configuredS3Bucket } from '@/lib/persistence/s3-client-config';

describe('configuredAssetS3Client', () => {
  it('leaves the AWS SDK default chains intact when app-specific settings are absent', () => {
    expect(
      configuredAssetS3Client({
        AWS_REGION: 'legacy-region',
        AWS_ACCESS_KEY_ID: 'legacy-key',
        AWS_SECRET_ACCESS_KEY: 'legacy-secret',
      }),
    ).toEqual({});
  });

  it('builds explicit Supabase-compatible client settings', () => {
    expect(
      configuredAssetS3Client({
        ASSET_S3_ENDPOINT: ' https://project-ref.storage.supabase.co/storage/v1/s3/ ',
        ASSET_S3_REGION: ' ap-southeast-1 ',
        ASSET_S3_ACCESS_KEY_ID: ' test-access ',
        ASSET_S3_SECRET_ACCESS_KEY: ' test-secret ',
      }),
    ).toEqual({
      endpoint: 'https://project-ref.storage.supabase.co/storage/v1/s3',
      region: 'ap-southeast-1',
      forcePathStyle: true,
      credentials: { accessKeyId: 'test-access', secretAccessKey: 'test-secret' },
    });
  });

  it('honors an explicit path-style override', () => {
    expect(
      configuredAssetS3Client({
        ASSET_S3_ENDPOINT: 'https://objects.example.test',
        ASSET_S3_FORCE_PATH_STYLE: 'false',
      }),
    ).toMatchObject({ forcePathStyle: false });
  });

  it('rejects partial credentials and malformed settings without echoing values', () => {
    expect(() =>
      configuredAssetS3Client({ ASSET_S3_ACCESS_KEY_ID: 'access-without-secret' }),
    ).toThrow('must be configured together');
    expect(() => configuredAssetS3Client({ ASSET_S3_ENDPOINT: 'not-a-url' })).toThrow(
      'Invalid ASSET_S3_ENDPOINT',
    );
    expect(() => configuredAssetS3Client({ ASSET_S3_FORCE_PATH_STYLE: 'sometimes' })).toThrow(
      'Invalid ASSET_S3_FORCE_PATH_STYLE',
    );
  });
});

describe('configuredS3Bucket', () => {
  it('uses the caller-provided variable name in validation failures', () => {
    expect(() => configuredS3Bucket('../invalid', 'MATERIAL_S3_BUCKET')).toThrow(
      'Invalid MATERIAL_S3_BUCKET',
    );
  });
});
