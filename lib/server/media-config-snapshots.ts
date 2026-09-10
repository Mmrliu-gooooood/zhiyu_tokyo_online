import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Queryable, WithTransaction } from '@openmaic/storage/document/pg';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { nodePostgresTransaction } from '@/lib/server/agent-runtime/store';
import { MediaConfigRefSchema, type MediaConfigRef } from '@/lib/server/generation-jobs/contracts';
import { assertGenerationSchema } from '@/lib/server/generation-jobs/migrations';

export class MediaConfigSnapshotError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
    this.name = 'MediaConfigSnapshotError';
  }
}

export const MEDIA_CONFIG_SNAPSHOT_SCHEMA_VERSION = 2;
const SUPPORTED_MEDIA_CONFIG_SNAPSHOT_VERSIONS = new Set([1, 2]);

const providerInstanceId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9_.:/-]+$/);
const apiKey = z.string().max(16_384).optional().default('');
const modelId = z.string().trim().min(1).max(500);
const optionalBuiltInModelId = z.string().trim().max(500);
const baseUrl = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .url()
  .superRefine((value, context) => {
    if (!URL.canParse(value)) return;
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      context.addIssue({ code: 'custom', message: 'Unsafe media provider URL' });
    }
  });
const common = {
  apiKey,
  baseUrl,
  requiresApiKey: z.boolean().optional().default(true),
  enabled: z.boolean().optional().default(true),
  modelId,
};
const customImageConfig = z
  .object({
    providerId: providerInstanceId.refine((id) => id.startsWith('custom-image-')),
    protocol: z.enum(['openai-images', 'siliconflow-images', 'openrouter-images']),
    ...common,
  })
  .strict();
const customVideoConfig = z
  .object({
    providerId: providerInstanceId.refine((id) => id.startsWith('custom-video-')),
    protocol: z.enum(['siliconflow-video', 'openrouter-video']),
    ...common,
  })
  .strict();
const customTtsConfig = z
  .object({
    providerId: providerInstanceId.refine((id) => id.startsWith('custom-tts-')),
    protocol: z.literal('openai-speech'),
    ...common,
    voice: z.string().trim().min(1).max(500),
    default: z.boolean().optional(),
    speed: z.number().min(0.25).max(4).optional(),
    format: z.string().trim().min(1).max(32).optional(),
    providerOptions: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const builtInCommon = {
  apiKey,
  baseUrl: z.union([baseUrl, z.literal('')]),
  requiresApiKey: z.boolean().optional().default(true),
  enabled: z.boolean().optional().default(true),
  modelId: optionalBuiltInModelId,
};

const BUILT_IN_PROVIDER_ORIGINS: Record<string, string> = {
  seedream: 'https://ark.cn-beijing.volces.com',
  'openai-image': 'https://api.openai.com',
  'qwen-image': 'https://dashscope.aliyuncs.com',
  'nano-banana': 'https://generativelanguage.googleapis.com',
  'minimax-image': 'https://api.minimaxi.com',
  'grok-image': 'https://api.x.ai',
  seedance: 'https://ark.cn-beijing.volces.com',
  kling: 'https://api-beijing.klingai.com',
  veo: 'https://generativelanguage.googleapis.com',
  'minimax-video': 'https://api.minimaxi.com',
  'grok-video': 'https://api.x.ai',
  happyhorse: 'https://dashscope.aliyuncs.com',
  'openai-tts': 'https://api.openai.com',
  'glm-tts': 'https://open.bigmodel.cn',
  'qwen-tts': 'https://dashscope.aliyuncs.com',
  'doubao-tts': 'https://openspeech.bytedance.com',
  'elevenlabs-tts': 'https://api.elevenlabs.io',
  'minimax-tts': 'https://api.minimaxi.com',
};
const LOCAL_BUILT_IN_PROVIDERS = new Set([
  'comfyui-image',
  'lemonade',
  'voxcpm-tts',
  'lemonade-tts',
]);

function validateBuiltInBaseUrl(
  value: { providerId: string; baseUrl: string },
  context: z.RefinementCtx,
) {
  if (!value.baseUrl || LOCAL_BUILT_IN_PROVIDERS.has(value.providerId)) return;
  const url = new URL(value.baseUrl);
  const allowed = BUILT_IN_PROVIDER_ORIGINS[value.providerId];
  const azure =
    value.providerId === 'azure-tts' &&
    url.protocol === 'https:' &&
    /^[a-z0-9-]+\.tts\.speech\.microsoft\.com$/i.test(url.hostname);
  if (!azure && url.origin !== allowed) {
    context.addIssue({
      code: 'custom',
      path: ['baseUrl'],
      message: 'Built-in media provider URL must use its official origin',
    });
  }
}
const builtInImageConfig = z
  .object({
    providerId: z.enum([
      'seedream',
      'openai-image',
      'qwen-image',
      'nano-banana',
      'minimax-image',
      'grok-image',
      'comfyui-image',
      'lemonade',
    ]),
    ...builtInCommon,
  })
  .strict()
  .superRefine(validateBuiltInBaseUrl);
const builtInVideoConfig = z
  .object({
    providerId: z.enum(['seedance', 'kling', 'veo', 'minimax-video', 'grok-video', 'happyhorse']),
    ...builtInCommon,
  })
  .strict()
  .superRefine(validateBuiltInBaseUrl);
const builtInTtsConfig = z
  .object({
    providerId: z.enum([
      'openai-tts',
      'azure-tts',
      'glm-tts',
      'qwen-tts',
      'doubao-tts',
      'elevenlabs-tts',
      'minimax-tts',
      'voxcpm-tts',
      'lemonade-tts',
    ]),
    ...builtInCommon,
    voice: z.string().trim().min(1).max(500),
    default: z.boolean().optional(),
    speed: z.number().min(0.25).max(4).optional(),
    format: z.string().trim().min(1).max(32).optional(),
    providerOptions: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine(validateBuiltInBaseUrl);
const imageConfig = z.union([customImageConfig, builtInImageConfig]);
const videoConfig = z.union([customVideoConfig, builtInVideoConfig]);
const ttsConfig = z.union([customTtsConfig, builtInTtsConfig]);
const ttsExecutionOptions = {
  speed: z.number().min(0.25).max(4).optional(),
  format: z.string().trim().min(1).max(32).optional(),
  providerOptions: z.record(z.string(), z.unknown()).optional(),
};
const customTtsProviderConfig = z
  .object({
    providerId: providerInstanceId.refine((id) => id.startsWith('custom-tts-')),
    protocol: z.literal('openai-speech'),
    ...common,
    ...ttsExecutionOptions,
  })
  .strict();
const builtInTtsProviderConfig = z
  .object({
    providerId: z.enum([
      'openai-tts',
      'azure-tts',
      'glm-tts',
      'qwen-tts',
      'doubao-tts',
      'elevenlabs-tts',
      'minimax-tts',
      'voxcpm-tts',
      'lemonade-tts',
    ]),
    ...builtInCommon,
    ...ttsExecutionOptions,
  })
  .strict()
  .superRefine(validateBuiltInBaseUrl);
const ttsProviderConfig = z.union([customTtsProviderConfig, builtInTtsProviderConfig]);
const ttsVoiceBinding = z
  .object({
    providerId: providerInstanceId,
    modelId,
    voiceId: z.string().trim().min(1).max(500),
    speed: z.number().min(0.25).max(4).optional(),
  })
  .strict();
const ttsVoiceDirectoryEntry = z
  .object({
    providerId: providerInstanceId,
    modelId,
    voiceIds: z.array(z.string().trim().min(1).max(500)).min(1).max(1_000),
  })
  .strict();
const mediaIntent = {
  imageEnabled: z.boolean().optional(),
  videoEnabled: z.boolean().optional(),
  ttsEnabled: z.boolean().optional(),
  image: imageConfig.optional(),
  video: videoConfig.optional(),
};

const MediaConfigSnapshotV1Schema = z
  .object({
    version: z.literal(1),
    ...mediaIntent,
    tts: z.array(ttsConfig).max(100).optional(),
    ttsProviders: z.never().optional(),
    ttsDefault: z.never().optional(),
    ttsVoiceDirectory: z.never().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.image ||
      value.video ||
      value.tts?.length ||
      value.imageEnabled !== undefined ||
      value.videoEnabled !== undefined ||
      value.ttsEnabled !== undefined,
    {
      message: 'At least one media provider configuration or explicit intent is required',
    },
  );

const MediaConfigSnapshotV2Schema = z
  .object({
    version: z.literal(2),
    ...mediaIntent,
    tts: z.never().optional(),
    ttsProviders: z.array(ttsProviderConfig).max(100).optional(),
    ttsDefault: ttsVoiceBinding.optional(),
    ttsVoiceDirectory: z.array(ttsVoiceDirectoryEntry).max(100).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const providerKeys = new Set<string>();
    for (const config of value.ttsProviders ?? []) {
      const key = `${config.providerId}\0${config.modelId}`;
      if (providerKeys.has(key)) {
        context.addIssue({ code: 'custom', message: 'Duplicate TTS provider/model execution config' });
      }
      providerKeys.add(key);
    }
    const directoryKeys = new Set<string>();
    for (const entry of value.ttsVoiceDirectory ?? []) {
      const key = `${entry.providerId}\0${entry.modelId}`;
      if (!providerKeys.has(key)) {
        context.addIssue({ code: 'custom', message: 'Voice directory has no execution config' });
      }
      if (directoryKeys.has(key) || new Set(entry.voiceIds).size !== entry.voiceIds.length) {
        context.addIssue({ code: 'custom', message: 'Duplicate voice directory entry' });
      }
      directoryKeys.add(key);
    }
    if (value.ttsDefault) {
      const key = `${value.ttsDefault.providerId}\0${value.ttsDefault.modelId}`;
      const directory = value.ttsVoiceDirectory?.find(
        (entry) => `${entry.providerId}\0${entry.modelId}` === key,
      );
      if (!providerKeys.has(key) || !directory?.voiceIds.includes(value.ttsDefault.voiceId)) {
        context.addIssue({ code: 'custom', message: 'Default voice is outside the voice directory' });
      }
    }
  })
  .refine(
    (value) =>
      value.image ||
      value.video ||
      value.ttsProviders?.length ||
      value.imageEnabled !== undefined ||
      value.videoEnabled !== undefined ||
      value.ttsEnabled !== undefined,
    { message: 'At least one media provider configuration or explicit intent is required' },
  );

export const MediaConfigSnapshotContentSchema = z.discriminatedUnion('version', [
  MediaConfigSnapshotV1Schema,
  MediaConfigSnapshotV2Schema,
]);
export type MediaConfigSnapshotContent = z.infer<typeof MediaConfigSnapshotContentSchema>;

export function parseMediaConfigRef(value: unknown): MediaConfigRef | undefined {
  const parsed = MediaConfigRefSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function encryptionKey(): Buffer {
  const configured = process.env.MEDIA_CONFIG_ENCRYPTION_KEY?.trim();
  if (!configured || !/^[a-f0-9]{64}$/i.test(configured)) {
    throw new MediaConfigSnapshotError('MEDIA_CONFIG_ENCRYPTION_UNAVAILABLE', 503);
  }
  return Buffer.from(configured, 'hex');
}

function canonicalJson(value: unknown): string {
  const canonical = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(canonical)
      : item && typeof item === 'object'
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([key, child]) => [key, canonical(child)]),
          )
        : item;
  return JSON.stringify(canonical(value));
}

function aad(ownerId: string, ref: MediaConfigRef): Buffer {
  return Buffer.from(JSON.stringify(['media-config:v1', ownerId, ref.id, ref.revision]));
}

function seal(content: MediaConfigSnapshotContent, ownerId: string, ref: MediaConfigRef): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(aad(ownerId, ref));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(content), 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    encrypted.toString('base64'),
  ].join('.');
}

function unseal(
  ciphertext: string,
  ownerId: string,
  ref: MediaConfigRef,
  schemaVersion: number,
): MediaConfigSnapshotContent {
  try {
    const [version, iv, tag, encrypted, extra] = ciphertext.split('.');
    if (version !== 'v1' || extra || !iv || !tag || !encrypted) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64'));
    decipher.setAAD(aad(ownerId, ref));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encrypted, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    const content = MediaConfigSnapshotContentSchema.parse(JSON.parse(plaintext));
    if (content.version !== schemaVersion) throw new Error();
    return content;
  } catch (error) {
    if (
      error instanceof MediaConfigSnapshotError &&
      error.code === 'MEDIA_CONFIG_ENCRYPTION_UNAVAILABLE'
    ) {
      throw error;
    }
    throw new MediaConfigSnapshotError('MEDIA_CONFIG_DECRYPTION_FAILED', 503);
  }
}

function parseContent(value: unknown): MediaConfigSnapshotContent {
  const parsed = MediaConfigSnapshotContentSchema.safeParse(value);
  if (!parsed.success) throw new MediaConfigSnapshotError('MEDIA_CONFIG_INVALID');
  for (const config of [
    parsed.data.image,
    parsed.data.video,
    ...(parsed.data.tts ?? []),
    ...(parsed.data.ttsProviders ?? []),
  ]) {
    const isCustom = config?.providerId.startsWith('custom-');
    if (config?.requiresApiKey && !config.apiKey.trim() && !isCustom) {
      // A built-in provider may be server-managed; the authoritative key check
      // happens after the owner-scoped snapshot is loaded by the consumer.
      continue;
    }
    if (config?.requiresApiKey && !config.apiKey.trim()) {
      throw new MediaConfigSnapshotError('MEDIA_CONFIG_KEY_REQUIRED');
    }
  }
  return parsed.data;
}

function providerInstanceIds(content: MediaConfigSnapshotContent): string[] {
  return [
    content.image?.providerId,
    content.video?.providerId,
    ...(content.tts ?? []).map((v) => v.providerId),
    ...(content.ttsProviders ?? []).map((v) => v.providerId),
    ...(content.ttsVoiceDirectory ?? []).map((v) => v.providerId),
  ]
    .filter((value): value is string => !!value)
    .filter((value, index, all) => all.indexOf(value) === index)
    .sort();
}

/** Immutable, owner-scoped snapshots. Identical active content reuses its opaque reference. */
export class MediaConfigSnapshotStore {
  constructor(
    private readonly db: Queryable,
    private readonly transaction: WithTransaction = async (body) => body(db),
  ) {}

  async create(ownerId: string, value: unknown): Promise<MediaConfigRef> {
    const content = parseContent(value);
    const key = encryptionKey();
    const intentDigest = createHmac('sha256', key)
      .update(`media-config-intent:v1\0${ownerId}\0${canonicalJson(content)}`)
      .digest('hex');
    return this.transaction(async (db) => {
      const existing = await db.query<{ id: string; revision: number }>(
        'SELECT id,revision FROM media_config_snapshots WHERE owner_id=$1 AND intent_digest=$2 AND revoked_at IS NULL LIMIT 1',
        [ownerId, intentDigest],
      );
      if (existing.rows[0]) return existing.rows[0];

      const ref = { id: randomUUID(), revision: 1 };
      const inserted = await db.query<{ id: string; revision: number }>(
        `INSERT INTO media_config_snapshots
          (id,owner_id,revision,schema_version,ciphertext,intent_digest,provider_instance_ids)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
         ON CONFLICT DO NOTHING RETURNING id,revision`,
        [
          ref.id,
          ownerId,
          ref.revision,
          content.version,
          seal(content, ownerId, ref),
          intentDigest,
          JSON.stringify(providerInstanceIds(content)),
        ],
      );
      if (inserted.rows[0]) return inserted.rows[0];
      const raced = await db.query<{ id: string; revision: number }>(
        'SELECT id,revision FROM media_config_snapshots WHERE owner_id=$1 AND intent_digest=$2 AND revoked_at IS NULL LIMIT 1',
        [ownerId, intentDigest],
      );
      if (!raced.rows[0])
        throw new MediaConfigSnapshotError('MEDIA_CONFIG_SNAPSHOT_UNAVAILABLE', 503);
      return raced.rows[0];
    });
  }

  async load(ownerId: string, ref: MediaConfigRef): Promise<MediaConfigSnapshotContent> {
    const parsed = parseMediaConfigRef(ref);
    if (!parsed) throw new MediaConfigSnapshotError('MEDIA_CONFIG_INVALID_REFERENCE');
    const result = await this.db.query<{ ciphertext: string; schema_version: number }>(
      `SELECT ciphertext,schema_version FROM media_config_snapshots
       WHERE id=$1 AND revision=$2 AND owner_id=$3 AND revoked_at IS NULL`,
      [parsed.id, parsed.revision, ownerId],
    );
    const row = result.rows[0];
    const schemaVersion = Number(row?.schema_version);
    if (!row || !SUPPORTED_MEDIA_CONFIG_SNAPSHOT_VERSIONS.has(schemaVersion)) {
      throw new MediaConfigSnapshotError('MEDIA_CONFIG_SNAPSHOT_UNAVAILABLE', 409);
    }
    return unseal(row.ciphertext, ownerId, parsed, schemaVersion);
  }

  async revokeByProviderInstance(ownerId: string, providerId: string): Promise<number> {
    if (!providerInstanceId.safeParse(providerId).success) {
      throw new MediaConfigSnapshotError('MEDIA_CONFIG_INVALID_PROVIDER_INSTANCE');
    }
    const result = await this.db.query<{ id: string }>(
      `UPDATE media_config_snapshots SET revoked_at=clock_timestamp()
       WHERE owner_id=$1 AND revoked_at IS NULL AND provider_instance_ids ? $2
       RETURNING id`,
      [ownerId, providerId],
    );
    return result.rows.length;
  }
}

const stores = new WeakMap<object, Promise<MediaConfigSnapshotStore>>();
async function getStore(): Promise<MediaConfigSnapshotStore> {
  if (!process.env.DATABASE_URL) {
    throw new MediaConfigSnapshotError('MEDIA_CONFIG_DATABASE_UNAVAILABLE', 503);
  }
  const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL);
  let pending = stores.get(pool);
  if (!pending) {
    pending = assertGenerationSchema(pool).then(
      () => new MediaConfigSnapshotStore(pool, nodePostgresTransaction(pool)),
    );
    stores.set(pool, pending);
    pending.catch(() => stores.delete(pool));
  }
  return pending;
}

export async function syncMediaConfigSnapshot(
  ownerId: string,
  value: unknown,
): Promise<MediaConfigRef> {
  return (await getStore()).create(ownerId, value);
}

export async function loadMediaConfigSnapshot(
  ownerId: string,
  ref: MediaConfigRef,
): Promise<MediaConfigSnapshotContent> {
  return (await getStore()).load(ownerId, ref);
}

export async function revokeMediaConfigSnapshots(
  ownerId: string,
  providerInstanceId: string,
): Promise<number> {
  return (await getStore()).revokeByProviderInstance(ownerId, providerInstanceId);
}
