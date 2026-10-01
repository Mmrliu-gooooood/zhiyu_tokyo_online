import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Queryable } from '@openmaic/storage/document/pg';

const mocks = vi.hoisted(() => ({ disabled: new Set<string>(), modelInputs: [] as unknown[] }));
vi.mock('@/lib/server/provider-config', () => ({
  getServerProviders: () => ({ openai: { models: ['gpt-test'] } }),
  getServerTTSProviders: () => ({}),
  getServerImageProviders: () => ({}),
  getServerVideoProviders: () => ({}),
  getServerWebSearchProviders: () => ({}),
  isServerProviderDisabled: (_section: string, id: string) => mocks.disabled.has(id),
  resolveImageApiKey: (_id: string, key?: string) => key || '',
  resolveImageModel: (_id: string, model?: string) => model,
  resolveVideoApiKey: (_id: string, key?: string) => key || '',
  resolveVideoModel: (_id: string, model?: string) => model,
  resolveTTSApiKey: (_id: string, key?: string) => key || '',
  resolveTTSModel: (_id: string, model?: string) => model,
}));
vi.mock('@/lib/model-gateway', async (importOriginal) =>
  (await import('@/tests/helpers/model-gateway-mock')).mockGatewayModule(await importOriginal(), {
    resolveParamsBinding: vi.fn(async (input: unknown) => {
      mocks.modelInputs.push(input);
      return {
        source: 'legacy-managed',
        providerId: 'openai',
        modelId: 'gpt-test',
        modelString: 'openai:gpt-test',
        credentialReady: true,
      };
    }),
  }),
);

import { MediaConfigSnapshotStore } from '@/lib/server/media-config-snapshots';
import { GenerationModelSnapshotStore } from '@/lib/server/generation-model-snapshots';
import {
  GENERATION_MIGRATION_2,
  GENERATION_MIGRATION_3,
} from '@/lib/server/generation-jobs/migrations';
import { parseGenerationInput } from '@/lib/server/generation-jobs/contracts';
import { validateBackgroundProviders } from '@/lib/server/generation-jobs/preflight';

describe('background media snapshot preflight', () => {
  let db: PGlite;
  let queryable: Queryable;
  let store: MediaConfigSnapshotStore;

  beforeEach(async () => {
    vi.stubEnv('MEDIA_CONFIG_ENCRYPTION_KEY', 'ab'.repeat(32));
    vi.stubEnv('ASSET_S3_BUCKET', '');
    mocks.disabled.clear();
    mocks.modelInputs.length = 0;
    db = new PGlite();
    await db.exec(`
      CREATE TABLE generation_jobs(owner_id TEXT, status TEXT, input_snapshot JSONB);
      ${GENERATION_MIGRATION_2}
      ${GENERATION_MIGRATION_3}
    `);
    queryable = { query: (sql, values) => db.query(sql, values ? [...values] : []) };
    store = new MediaConfigSnapshotStore(queryable);
  });

  afterEach(async () => {
    await db.close();
    vi.unstubAllEnvs();
  });

  async function input(ownerId = 'owner-a') {
    const ref = await store.create(ownerId, {
      version: 1,
      image: {
        providerId: 'custom-image-private',
        protocol: 'openai-images',
        apiKey: 'image-key',
        baseUrl: 'https://images.example.test/v1',
        modelId: 'image-model',
      },
      video: {
        providerId: 'custom-video-private',
        protocol: 'siliconflow-video',
        apiKey: 'video-key',
        baseUrl: 'https://video.example.test/v1',
        modelId: 'video-model',
      },
      tts: [
        {
          providerId: 'custom-tts-private',
          protocol: 'openai-speech',
          apiKey: 'tts-key',
          baseUrl: 'https://tts.example.test/v1',
          modelId: 'tts-model',
          voice: 'voice-one',
        },
      ],
    });
    return parseGenerationInput({
      version: 1,
      requirements: { requirement: 'test' },
      enableImageGeneration: true,
      enableVideoGeneration: true,
      media: {
        image: { providerId: 'custom-image-private', modelId: 'image-model' },
        video: { providerId: 'custom-video-private', modelId: 'video-model' },
      },
      tts: {
        enabled: true,
        providerId: 'custom-tts-private',
        modelId: 'tts-model',
        voice: 'voice-one',
      },
      mediaConfigRef: ref,
    });
  }

  it('validates every selected custom media provider against the owner snapshot', async () => {
    await expect(
      validateBackgroundProviders(await input(), { ownerId: 'owner-a', queryable }),
    ).resolves.toBeUndefined();
  });

  it('resolves every unrouted stage with the owner model snapshot without exposing it in the job', async () => {
    vi.stubEnv('GENERATION_MODEL_ENCRYPTION_KEY', 'cd'.repeat(32));
    const ref = await new GenerationModelSnapshotStore(queryable).create('owner-a', {
      version: 1,
      modelString: 'openai:gpt-test',
      apiKey: 'owner-model-key',
      providerType: 'openai',
      api: 'openai-completions',
    });
    const value = parseGenerationInput({
      version: 1,
      requirements: { requirement: 'test' },
      modelConfigRef: ref,
    });
    expect(JSON.stringify(value)).not.toContain('owner-model-key');
    await validateBackgroundProviders(value, { ownerId: 'owner-a', queryable });
    expect(mocks.modelInputs).toHaveLength(8);
    expect(mocks.modelInputs[0]).toMatchObject({ apiKey: 'owner-model-key' });
  });

  it('rejects owner mismatch, missing context, provider mismatch and revoked snapshots', async () => {
    const valid = await input();
    await expect(validateBackgroundProviders(valid)).rejects.toThrow(
      'BACKGROUND_MEDIA_PROVIDER_UNAVAILABLE',
    );
    await expect(
      validateBackgroundProviders(valid, { ownerId: 'owner-b', queryable }),
    ).rejects.toThrow('BACKGROUND_MEDIA_PROVIDER_UNAVAILABLE');
    await expect(
      validateBackgroundProviders(
        parseGenerationInput({
          ...valid,
          media: {
            ...valid.media,
            image: { providerId: 'custom-image-other', modelId: 'image-model' },
          },
        }),
        { ownerId: 'owner-a', queryable },
      ),
    ).rejects.toThrow('BACKGROUND_IMAGE_PROVIDER_UNAVAILABLE');

    await store.revokeByProviderInstance('owner-a', 'custom-image-private');
    await expect(
      validateBackgroundProviders(valid, { ownerId: 'owner-a', queryable }),
    ).rejects.toThrow('BACKGROUND_MEDIA_PROVIDER_UNAVAILABLE');
  });

  it('applies administrator disable policy before accepting snapshot credentials', async () => {
    const valid = await input();
    mocks.disabled.add('custom-image-private');
    await expect(
      validateBackgroundProviders(valid, { ownerId: 'owner-a', queryable }),
    ).rejects.toThrow('BACKGROUND_IMAGE_PROVIDER_UNAVAILABLE');
  });

  it('accepts an unmanaged built-in MiniMax TTS configuration from the encrypted snapshot', async () => {
    const ref = await store.create('owner-a', {
      version: 1,
      imageEnabled: false,
      videoEnabled: false,
      ttsEnabled: true,
      tts: [
        {
          providerId: 'minimax-tts',
          apiKey: 'client-key',
          baseUrl: '',
          enabled: true,
          requiresApiKey: true,
          modelId: 'speech-2.8-hd',
          voice: 'male-qn-qingse',
        },
      ],
    });
    const builtIn = parseGenerationInput({
      version: 1,
      requirements: { requirement: 'test' },
      tts: {
        enabled: true,
        providerId: 'minimax-tts',
        modelId: 'speech-2.8-hd',
        voice: 'male-qn-qingse',
      },
      mediaConfigRef: ref,
    });

    await expect(
      validateBackgroundProviders(builtIn, { ownerId: 'owner-a', queryable }),
    ).resolves.toBeUndefined();
  });

  it('validates v2 role bindings against the complete owner voice directory', async () => {
    const ref = await store.create('owner-a', {
      version: 2,
      imageEnabled: false,
      videoEnabled: false,
      ttsEnabled: true,
      ttsProviders: [
        {
          providerId: 'minimax-tts',
          apiKey: 'client-key',
          baseUrl: '',
          enabled: true,
          requiresApiKey: true,
          modelId: 'speech-2.8-hd',
        },
      ],
      ttsDefault: {
        providerId: 'minimax-tts',
        modelId: 'speech-2.8-hd',
        voiceId: 'female-yujie',
      },
      ttsVoiceDirectory: [
        {
          providerId: 'minimax-tts',
          modelId: 'speech-2.8-hd',
          voiceIds: ['female-yujie', 'male-qn-jingying'],
        },
      ],
    });
    const valid = parseGenerationInput({
      version: 1,
      requirements: { requirement: 'test' },
      tts: {
        enabled: true,
        providerId: 'minimax-tts',
        modelId: 'speech-2.8-hd',
        voice: 'female-yujie',
        agentVoiceOverrides: {
          teacher: {
            providerId: 'minimax-tts',
            modelId: 'speech-2.8-hd',
            voiceId: 'male-qn-jingying',
          },
        },
      },
      mediaConfigRef: ref,
    });
    await expect(
      validateBackgroundProviders(valid, { ownerId: 'owner-a', queryable }),
    ).resolves.toBeUndefined();

    const outsideDirectory = parseGenerationInput({
      ...valid,
      tts: {
        ...valid.tts!,
        agentVoiceOverrides: {
          teacher: {
            providerId: 'minimax-tts',
            modelId: 'speech-2.8-hd',
            voiceId: 'not-in-directory',
          },
        },
      },
    });
    await expect(
      validateBackgroundProviders(outsideDirectory, { ownerId: 'owner-a', queryable }),
    ).rejects.toThrow('BACKGROUND_TTS_PROVIDER_UNAVAILABLE');
  });

  it('does not fall back to a server provider when the snapshot explicitly disables TTS', async () => {
    const ref = await store.create('owner-a', {
      version: 1,
      imageEnabled: false,
      videoEnabled: false,
      ttsEnabled: false,
    });
    const contradictory = parseGenerationInput({
      version: 1,
      requirements: { requirement: 'test' },
      tts: { enabled: true, providerId: 'minimax-tts', modelId: 'speech-2.8-hd' },
      mediaConfigRef: ref,
    });

    await expect(
      validateBackgroundProviders(contradictory, { ownerId: 'owner-a', queryable }),
    ).rejects.toThrow('BACKGROUND_TTS_PROVIDER_UNAVAILABLE');
  });
});
