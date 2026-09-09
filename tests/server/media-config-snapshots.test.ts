import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Queryable } from '@openmaic/storage/document/pg';
import {
  MediaConfigSnapshotStore,
  type MediaConfigSnapshotContent,
} from '@/lib/server/media-config-snapshots';
import { GENERATION_MIGRATION_2 } from '@/lib/server/generation-jobs/migrations';
import { parseGenerationInput } from '@/lib/server/generation-jobs/contracts';

const snapshot: MediaConfigSnapshotContent = {
  version: 1,
  image: {
    providerId: 'custom-image-private',
    protocol: 'openai-images',
    apiKey: 'image-secret-canary',
    baseUrl: 'https://images.example.test/v1',
    requiresApiKey: true,
    enabled: true,
    modelId: 'image-model',
  },
  video: {
    providerId: 'custom-video-private',
    protocol: 'siliconflow-video',
    apiKey: 'video-secret-canary',
    baseUrl: 'https://video.example.test/v1',
    requiresApiKey: true,
    enabled: true,
    modelId: 'video-model',
  },
  tts: [
    {
      providerId: 'custom-tts-private',
      protocol: 'openai-speech',
      apiKey: 'tts-secret-canary',
      baseUrl: 'https://tts.example.test/v1',
      requiresApiKey: true,
      enabled: true,
      modelId: 'tts-model',
      voice: 'voice-one',
    },
  ],
};

describe('encrypted media configuration snapshots', () => {
  let db: PGlite;
  let queryable: Queryable;
  let store: MediaConfigSnapshotStore;

  beforeEach(async () => {
    vi.stubEnv('MEDIA_CONFIG_ENCRYPTION_KEY', 'ab'.repeat(32));
    vi.stubEnv('PRO_MODEL_ENCRYPTION_KEY', '');
    db = new PGlite();
    await db.exec(GENERATION_MIGRATION_2);
    queryable = { query: (sql, values) => db.query(sql, values ? [...values] : []) };
    store = new MediaConfigSnapshotStore(queryable);
  });

  afterEach(async () => {
    await db.close();
    vi.unstubAllEnvs();
  });

  it('encrypts strict known media content and deduplicates the same owner intent', async () => {
    const first = await store.create('owner-a', snapshot);
    expect(await store.create('owner-a', snapshot)).toEqual(first);
    expect(first).toMatchObject({ revision: 1 });

    const saved = await db.query('SELECT * FROM media_config_snapshots');
    const serialized = JSON.stringify(saved.rows);
    expect(serialized).not.toContain('image-secret-canary');
    expect(serialized).not.toContain('https://images.example.test/v1');
    expect(serialized).toContain('custom-image-private');
    expect(await store.load('owner-a', first)).toEqual(snapshot);
  });

  it('isolates owners and revokes every snapshot containing a provider instance', async () => {
    const ownerRef = await store.create('owner-a', snapshot);
    const otherRef = await store.create('owner-b', snapshot);
    await expect(store.load('owner-b', ownerRef)).rejects.toMatchObject({
      code: 'MEDIA_CONFIG_SNAPSHOT_UNAVAILABLE',
    });

    expect(await store.revokeByProviderInstance('owner-a', 'custom-image-private')).toBe(1);
    await expect(store.load('owner-a', ownerRef)).rejects.toMatchObject({
      code: 'MEDIA_CONFIG_SNAPSHOT_UNAVAILABLE',
    });
    await expect(store.load('owner-b', otherRef)).resolves.toEqual(snapshot);
  });

  it('authenticates owner, reference and ciphertext with media-config:v1 AAD', async () => {
    const ref = await store.create('owner-a', snapshot);
    await db.query('UPDATE media_config_snapshots SET owner_id=$1 WHERE id=$2', [
      'owner-b',
      ref.id,
    ]);
    await expect(store.load('owner-b', ref)).rejects.toMatchObject({
      code: 'MEDIA_CONFIG_DECRYPTION_FAILED',
    });
  });

  it('fails closed when the dedicated media key is missing or invalid', async () => {
    vi.stubEnv('MEDIA_CONFIG_ENCRYPTION_KEY', '');
    vi.stubEnv('PRO_MODEL_ENCRYPTION_KEY', 'cd'.repeat(32));
    await expect(store.create('owner-a', snapshot)).rejects.toMatchObject({
      code: 'MEDIA_CONFIG_ENCRYPTION_UNAVAILABLE',
    });

    vi.stubEnv('MEDIA_CONFIG_ENCRYPTION_KEY', 'not-a-key');
    await expect(store.create('owner-a', { ...snapshot, image: undefined })).rejects.toMatchObject({
      code: 'MEDIA_CONFIG_ENCRYPTION_UNAVAILABLE',
    });

    vi.stubEnv('MEDIA_CONFIG_ENCRYPTION_KEY', '');
    vi.stubEnv('PRO_MODEL_ENCRYPTION_KEY', '');
    await expect(store.create('owner-a', snapshot)).rejects.toMatchObject({
      code: 'MEDIA_CONFIG_ENCRYPTION_UNAVAILABLE',
    });
  });

  it('rejects unknown snapshot fields and plaintext task credentials or URLs', async () => {
    await expect(
      store.create('owner-a', {
        ...snapshot,
        image: { ...snapshot.image!, authorization: 'Bearer canary' },
      }),
    ).rejects.toMatchObject({ code: 'MEDIA_CONFIG_INVALID' });

    const ref = await store.create('owner-a', snapshot);
    expect(
      parseGenerationInput({
        version: 1,
        requirements: { requirement: 'test' },
        mediaConfigRef: ref,
      }).mediaConfigRef,
    ).toEqual(ref);
    for (const plaintext of [
      { mediaConfigRef: { ...ref, apiKey: 'canary' } },
      { media: { image: { providerId: 'custom-image-private', modelId: 'm', apiKey: 'canary' } } },
      { mediaConfig: { baseUrl: 'https://private.example.test' } },
    ]) {
      expect(() =>
        parseGenerationInput({
          version: 1,
          requirements: { requirement: 'test' },
          ...plaintext,
        }),
      ).toThrow('INVALID_GENERATION_INPUT');
    }
  });

  it('accepts strict built-in provider branches and preserves provider-specific TTS options', async () => {
    const builtIn: MediaConfigSnapshotContent = {
      version: 1,
      imageEnabled: true,
      videoEnabled: true,
      ttsEnabled: true,
      image: {
        providerId: 'minimax-image',
        apiKey: 'image-secret',
        baseUrl: '',
        requiresApiKey: true,
        enabled: true,
        modelId: 'image-01',
      },
      video: {
        providerId: 'minimax-video',
        apiKey: 'video-secret',
        baseUrl: '',
        requiresApiKey: true,
        enabled: true,
        modelId: 'MiniMax-Hailuo-2.3',
      },
      tts: [
        {
          providerId: 'voxcpm-tts',
          apiKey: '',
          baseUrl: 'http://voxcpm.internal:8000',
          requiresApiKey: false,
          enabled: true,
          modelId: 'voxcpm',
          voice: 'voxcpm:auto',
          providerOptions: { backend: 'vllm-omni', voicePrompt: 'calm teacher' },
        },
      ],
    };
    const ref = await store.create('owner-a', builtIn);
    await expect(store.load('owner-a', ref)).resolves.toEqual(builtIn);

    await expect(
      store.create('owner-a', {
        version: 1,
        ttsEnabled: true,
        tts: [{ ...builtIn.tts![0], providerId: 'browser-native-tts' }],
      }),
    ).rejects.toMatchObject({ code: 'MEDIA_CONFIG_INVALID' });
  });

  it('rejects built-in credentials redirected to a non-official origin', async () => {
    await expect(
      store.create('owner-a', {
        version: 1,
        imageEnabled: true,
        image: {
          providerId: 'minimax-image',
          apiKey: 'secret',
          baseUrl: 'http://169.254.169.254/latest',
          requiresApiKey: true,
          enabled: true,
          modelId: 'image-01',
        },
      }),
    ).rejects.toMatchObject({ code: 'MEDIA_CONFIG_INVALID' });
  });

  it('rejects non-official origins for remote built-ins while preserving guarded local providers', async () => {
    await expect(
      store.create('owner-a', {
        version: 1,
        imageEnabled: true,
        image: {
          providerId: 'minimax-image',
          apiKey: 'secret',
          baseUrl: 'http://169.254.169.254/latest',
          requiresApiKey: true,
          enabled: true,
          modelId: 'image-01',
        },
      }),
    ).rejects.toMatchObject({ code: 'MEDIA_CONFIG_INVALID' });

    await expect(
      store.create('owner-a', {
        version: 1,
        imageEnabled: true,
        image: {
          providerId: 'comfyui-image',
          apiKey: '',
          baseUrl: 'http://comfyui.internal:8188',
          requiresApiKey: false,
          enabled: true,
          modelId: 'workflow.json',
        },
      }),
    ).resolves.toMatchObject({ revision: 1 });
  });
});
