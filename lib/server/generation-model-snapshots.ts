import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Queryable, WithTransaction } from '@openmaic/storage/document/pg';
import { tryAgentRuntimeDatabaseUrl } from '@/lib/db/database-urls';
import { getPersistencePool } from '@/lib/db/pool-registry';
import { createOwnerBoundQueryable } from '@/lib/db/request-queryable';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { nodePostgresTransaction } from '@/lib/server/agent-runtime/store';
import {
  GenerationModelRefSchema,
  type GenerationModelRef,
} from '@/lib/server/generation-jobs/contracts';
import { assertGenerationSchema } from '@/lib/server/generation-jobs/migrations';
import {
  GATEWAY_VERSION,
  LEGACY_SELECTION_VERSION,
  ModelSelectionError,
  persistedSelectionSchema,
  upgradeLegacyModelParams,
  type ModelSelection,
} from '@/lib/model-gateway';
import { CATALOG_VERSION } from '@/lib/model-gateway/catalog/client-catalog';
import type { ProModelContext } from '@/types/pro-model';

export class GenerationModelSnapshotError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
    this.name = 'GenerationModelSnapshotError';
  }
}

export const GENERATION_MODEL_SNAPSHOT_SCHEMA_VERSION = 3;
/** Content versions this build reads; only the current one is written. */
const READABLE_SCHEMA_VERSIONS = [1, 2, 3];
const thinkingConfigSchema = z
  .object({
    mode: z.enum(['default', 'disabled', 'enabled', 'auto']).optional(),
    effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
    level: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
    enabled: z.boolean().optional(),
    budgetTokens: z.number().int().nonnegative().max(1_000_000).optional(),
    excludeReasoningOutput: z.boolean().optional(),
  })
  .strict();
const legacyContentSchema = z
  .object({
    version: z.literal(1),
    modelString: z
      .string()
      .trim()
      .min(3)
      .max(500)
      .regex(/^[^:/\s]+[:/].+$/),
    apiKey: z.string().max(16_384).optional(),
    baseUrl: z.string().trim().max(2_048).url().optional(),
    providerType: z.enum(['openai', 'azure', 'anthropic', 'bedrock', 'google']).optional(),
    api: z.enum(['openai-completions', 'openai-responses']).optional(),
    thinkingConfig: thinkingConfigSchema.optional(),
  })
  .strict();
const sourcedModelSchema = z
  .object({
    source: z.enum(['user', 'legacy-managed']),
    modelString: z
      .string()
      .trim()
      .min(3)
      .max(500)
      .regex(/^[^:/\s]+[:/].+$/),
    apiKey: z.string().max(16_384).optional(),
    baseUrl: z.string().trim().max(2_048).url().optional(),
    providerType: z.enum(['openai', 'azure', 'anthropic', 'bedrock', 'google']).optional(),
    api: z.enum(['openai-completions', 'openai-responses']).optional(),
    thinkingConfig: thinkingConfigSchema.optional(),
  })
  .strict();
const platformModelSchema = z
  .object({
    source: z.literal('platform'),
    defaultId: z.literal('zhiyu-default-text'),
    revision: z.string().trim().min(1).max(500),
    thinkingConfig: thinkingConfigSchema.optional(),
  })
  .strict();
/** v3 (plan 3.14): the gateway ModelSelection plus the versions it was captured under. */
const selectionContentSchema = z
  .object({
    version: z.literal(3),
    selection: persistedSelectionSchema,
    catalogVersion: z.string().trim().min(1).max(200),
    gatewayVersion: z.string().trim().min(1).max(200),
  })
  .strict();
export const GenerationModelSnapshotContentSchema = z.union([
  legacyContentSchema,
  sourcedModelSchema.extend({ version: z.literal(2) }),
  platformModelSchema.extend({ version: z.literal(2) }),
  selectionContentSchema,
]);
const contentSchema = GenerationModelSnapshotContentSchema;

/** Any stored content version (v1, v2 user / managed / platform, v3). */
export type StoredGenerationModelSnapshotContent = z.infer<typeof contentSchema>;
/** The current content shape; loads always return it. */
export type GenerationModelSnapshotContent = z.infer<typeof selectionContentSchema>;

/**
 * Pure upgrade of any stored content to v3. v1 predates model sources and is
 * the operator-managed path; v2 platform content keeps its pinned revision.
 * Upgraded content records the `legacy` catalog / gateway versions.
 */
export function upgradeSnapshotContent(
  content: StoredGenerationModelSnapshotContent,
): GenerationModelSnapshotContent {
  if (content.version === 3) return content;
  const { version: _version, ...flat } = content;
  let selection: ModelSelection | undefined;
  try {
    selection = upgradeLegacyModelParams(flat);
  } catch (error) {
    if (!(error instanceof ModelSelectionError)) throw error;
  }
  const parsed = persistedSelectionSchema.safeParse(selection);
  if (!parsed.success) {
    throw new GenerationModelSnapshotError('GENERATION_MODEL_SNAPSHOT_UNAVAILABLE', 409);
  }
  return {
    version: 3,
    selection: parsed.data,
    catalogVersion: LEGACY_SELECTION_VERSION,
    gatewayVersion: LEGACY_SELECTION_VERSION,
  };
}

function key(): Buffer {
  const value = process.env.GENERATION_MODEL_ENCRYPTION_KEY?.trim();
  if (!value || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new GenerationModelSnapshotError('GENERATION_MODEL_ENCRYPTION_UNAVAILABLE', 503);
  }
  return Buffer.from(value, 'hex');
}

function canonical(value: unknown): string {
  const visit = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(visit)
      : item && typeof item === 'object'
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, visit(v)]),
          )
        : item;
  return JSON.stringify(visit(value));
}

function aad(ownerId: string, ref: GenerationModelRef): Buffer {
  return Buffer.from(JSON.stringify(['generation-model:v1', ownerId, ref.id, ref.revision]));
}

function seal(
  content: StoredGenerationModelSnapshotContent,
  ownerId: string,
  ref: GenerationModelRef,
) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(aad(ownerId, ref));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(content)), cipher.final()]);
  return [
    'v1',
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ].join('.');
}

function unseal(
  ciphertext: string,
  ownerId: string,
  ref: GenerationModelRef,
): StoredGenerationModelSnapshotContent {
  try {
    const [version, iv, tag, body, extra] = ciphertext.split('.');
    if (version !== 'v1' || extra || !iv || !tag || !body) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
    decipher.setAAD(aad(ownerId, ref));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return contentSchema.parse(
      JSON.parse(
        Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString(
          'utf8',
        ),
      ),
    );
  } catch (error) {
    if (error instanceof GenerationModelSnapshotError) throw error;
    throw new GenerationModelSnapshotError('GENERATION_MODEL_DECRYPTION_FAILED', 503);
  }
}

/** Operator-only migration helper: preserve the snapshot id/revision while changing AES-GCM AAD. */
export function reassignGenerationModelSnapshot(
  ciphertext: string,
  fromOwnerId: string,
  toOwnerId: string,
  ref: GenerationModelRef,
): { ciphertext: string; intentDigest: string } {
  const content = unseal(ciphertext, fromOwnerId, ref);
  return {
    ciphertext: seal(content, toOwnerId, ref),
    intentDigest: intentDigest(toOwnerId, content),
  };
}

function intentDigest(ownerId: string, content: StoredGenerationModelSnapshotContent): string {
  return createHmac('sha256', key())
    .update(`generation-model:v1\0${ownerId}\0${canonical(content)}`)
    .digest('hex');
}

/**
 * Operator / test helper: the AES-GCM envelope and intent digest for stored
 * content of any version. Stores themselves write only v3.
 */
export function sealGenerationModelSnapshot(
  content: StoredGenerationModelSnapshotContent,
  ownerId: string,
  ref: GenerationModelRef,
): { ciphertext: string; intentDigest: string } {
  const parsed = contentSchema.parse(content);
  return { ciphertext: seal(parsed, ownerId, ref), intentDigest: intentDigest(ownerId, parsed) };
}

/** v3 content for a run's model: the selection plus the catalog / gateway versions in force. */
export function generationModelSnapshotContent(
  value: Pick<ProModelContext, 'selection'>,
): GenerationModelSnapshotContent {
  const parsed = selectionContentSchema.safeParse({
    version: GENERATION_MODEL_SNAPSHOT_SCHEMA_VERSION,
    selection: value.selection,
    catalogVersion: CATALOG_VERSION,
    gatewayVersion: GATEWAY_VERSION,
  });
  if (!parsed.success) throw new GenerationModelSnapshotError('GENERATION_MODEL_INVALID');
  return parsed.data;
}

export class GenerationModelSnapshotStore {
  constructor(
    private readonly db: Queryable,
    private readonly transaction: WithTransaction = async (body) => body(db),
  ) {}

  async create(ownerId: string, value: unknown): Promise<GenerationModelRef> {
    const parsed = selectionContentSchema.safeParse(value);
    if (!parsed.success) throw new GenerationModelSnapshotError('GENERATION_MODEL_INVALID');
    const content = parsed.data;
    const digest = intentDigest(ownerId, content);
    return this.transaction(async (db) => {
      const existing = await db.query<GenerationModelRef>(
        'SELECT id,revision FROM generation_model_snapshots WHERE owner_id=$1 AND intent_digest=$2 AND revoked_at IS NULL LIMIT 1',
        [ownerId, digest],
      );
      if (existing.rows[0]) return existing.rows[0];
      const ref = { id: randomUUID(), revision: 1 };
      const inserted = await db.query<GenerationModelRef>(
        `INSERT INTO generation_model_snapshots(id,owner_id,revision,schema_version,ciphertext,intent_digest) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id,revision`,
        [ref.id, ownerId, ref.revision, content.version, seal(content, ownerId, ref), digest],
      );
      if (inserted.rows[0]) return inserted.rows[0];
      const raced = await db.query<GenerationModelRef>(
        'SELECT id,revision FROM generation_model_snapshots WHERE owner_id=$1 AND intent_digest=$2 AND revoked_at IS NULL LIMIT 1',
        [ownerId, digest],
      );
      if (!raced.rows[0])
        throw new GenerationModelSnapshotError('GENERATION_MODEL_SNAPSHOT_UNAVAILABLE', 503);
      return raced.rows[0];
    });
  }

  async load(ownerId: string, value: GenerationModelRef): Promise<GenerationModelSnapshotContent> {
    const parsed = GenerationModelRefSchema.safeParse(value);
    if (!parsed.success)
      throw new GenerationModelSnapshotError('GENERATION_MODEL_INVALID_REFERENCE');
    const result = await this.db.query<{ ciphertext: string; schema_version: number }>(
      `SELECT ciphertext,schema_version FROM generation_model_snapshots s
       WHERE id=$1 AND revision=$2 AND owner_id=$3
         AND (
           revoked_at IS NULL
           OR EXISTS (
             SELECT 1 FROM generation_jobs j
             WHERE j.owner_id=$3
               AND j.status NOT IN ('succeeded','failed','cancelled')
               AND j.input_snapshot->'modelConfigRef'->>'id'=$1::text
               AND (j.input_snapshot->'modelConfigRef'->>'revision')::int=$2
           )
         )`,
      [parsed.data.id, parsed.data.revision, ownerId],
    );
    const row = result.rows[0];
    if (!row || !READABLE_SCHEMA_VERSIONS.includes(Number(row.schema_version)))
      throw new GenerationModelSnapshotError('GENERATION_MODEL_SNAPSHOT_UNAVAILABLE', 409);
    const content = unseal(row.ciphertext, ownerId, parsed.data);
    if (content.version !== Number(row.schema_version)) {
      throw new GenerationModelSnapshotError('GENERATION_MODEL_DECRYPTION_FAILED', 503);
    }
    return upgradeSnapshotContent(content);
  }

  async revoke(ownerId: string, value: GenerationModelRef): Promise<boolean> {
    const parsed = GenerationModelRefSchema.safeParse(value);
    if (!parsed.success)
      throw new GenerationModelSnapshotError('GENERATION_MODEL_INVALID_REFERENCE');
    const result = await this.db.query<{ id: string }>(
      `UPDATE generation_model_snapshots SET revoked_at=clock_timestamp()
       WHERE id=$1 AND revision=$2 AND owner_id=$3 AND revoked_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM generation_jobs j
           WHERE j.owner_id=$3
             AND j.status NOT IN ('succeeded','failed','cancelled')
             AND j.input_snapshot->'modelConfigRef'->>'id'=$1::text
             AND (j.input_snapshot->'modelConfigRef'->>'revision')::int=$2
         )
       RETURNING id`,
      [parsed.data.id, parsed.data.revision, ownerId],
    );
    return result.rows.length === 1;
  }

  async cleanupExpired(
    retentionMs: number,
  ): Promise<{ readonly revoked: number; readonly deleted: number }> {
    const retention = Math.max(0, Math.trunc(retentionMs));
    return this.transaction(async (db) => {
      const revoked = await db.query<{ id: string }>(
        `UPDATE generation_model_snapshots s SET revoked_at=clock_timestamp()
         WHERE s.revoked_at IS NULL
           AND (
             (
               s.created_at<clock_timestamp()-$1*interval '1 millisecond'
               AND NOT EXISTS (
                 SELECT 1 FROM generation_jobs j
                 WHERE j.owner_id=s.owner_id
                   AND j.input_snapshot->'modelConfigRef'->>'id'=s.id::text
                   AND (j.input_snapshot->'modelConfigRef'->>'revision')::int=s.revision
               )
             )
             OR EXISTS (
               SELECT 1 FROM generation_jobs j
               WHERE j.owner_id=s.owner_id
                 AND j.status IN ('succeeded','failed','cancelled')
                 AND j.finished_at<clock_timestamp()-$1*interval '1 millisecond'
                 AND j.input_snapshot->'modelConfigRef'->>'id'=s.id::text
                 AND (j.input_snapshot->'modelConfigRef'->>'revision')::int=s.revision
             )
           )
           AND NOT EXISTS (
             SELECT 1 FROM generation_jobs j
             WHERE j.owner_id=s.owner_id
               AND j.input_snapshot->'modelConfigRef'->>'id'=s.id::text
               AND (j.input_snapshot->'modelConfigRef'->>'revision')::int=s.revision
               AND (
                 j.status NOT IN ('succeeded','failed','cancelled')
                 OR j.finished_at IS NULL
                 OR j.finished_at>=clock_timestamp()-$1*interval '1 millisecond'
               )
           )
         RETURNING id`,
        [retention],
      );
      const deleted = await db.query<{ id: string }>(
        `DELETE FROM generation_model_snapshots s
         WHERE s.revoked_at<clock_timestamp()-$1*interval '1 millisecond'
           AND NOT EXISTS (
             SELECT 1 FROM generation_jobs j
             WHERE j.owner_id=s.owner_id
               AND j.status NOT IN ('succeeded','failed','cancelled')
               AND j.input_snapshot->'modelConfigRef'->>'id'=s.id::text
               AND (j.input_snapshot->'modelConfigRef'->>'revision')::int=s.revision
           )
         RETURNING id`,
        [retention],
      );
      return { revoked: revoked.rows.length, deleted: deleted.rows.length };
    });
  }
}

const stores = new WeakMap<object, Promise<GenerationModelSnapshotStore>>();
async function store() {
  const connectionString = tryAgentRuntimeDatabaseUrl();
  if (!connectionString)
    throw new GenerationModelSnapshotError('GENERATION_MODEL_DATABASE_UNAVAILABLE', 503);
  const { pool } = await getServerPersistenceProvider(connectionString);
  let pending = stores.get(pool);
  if (!pending) {
    pending = assertGenerationSchema(pool).then(
      () => new GenerationModelSnapshotStore(pool, nodePostgresTransaction(pool)),
    );
    stores.set(pool, pending);
    pending.catch(() => stores.delete(pool));
  }
  return pending;
}

function ownerStore(ownerId: string): GenerationModelSnapshotStore {
  const db = createOwnerBoundQueryable(getPersistencePool(), ownerId);
  return new GenerationModelSnapshotStore(db, db.withTransaction);
}

export async function syncGenerationModelSnapshot(ownerId: string, value: unknown) {
  return ownerStore(ownerId).create(ownerId, value);
}
export async function loadGenerationModelSnapshot(ownerId: string, ref: GenerationModelRef) {
  return ownerStore(ownerId).load(ownerId, ref);
}
export async function cleanupGenerationModelSnapshots(retentionMs: number) {
  return (await store()).cleanupExpired(retentionMs);
}
