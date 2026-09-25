import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Queryable, WithTransaction } from '@openmaic/storage/document/pg';
import { tryAgentRuntimeDatabaseUrl } from '@/lib/db/database-urls';
import { getPersistencePool } from '@/lib/db/pool-registry';
import { createOwnerBoundQueryable } from '@/lib/db/request-queryable';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { nodePostgresTransaction } from '@/lib/server/agent-runtime/store';
import {
  GenerationSearchRefSchema,
  type GenerationSearchRef,
} from '@/lib/server/generation-jobs/contracts';
import { assertGenerationSchema } from '@/lib/server/generation-jobs/migrations';
import { isServerConfiguredProvider } from '@/lib/server/provider-config';
import { resolveSafeClientWebSearchBaseUrl } from '@/lib/server/web-search-config';

export class GenerationSearchSnapshotError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
    this.name = 'GenerationSearchSnapshotError';
  }
}

export const GENERATION_SEARCH_SNAPSHOT_SCHEMA_VERSION = 1;
const contentSchema = z
  .object({
    version: z.literal(GENERATION_SEARCH_SNAPSHOT_SCHEMA_VERSION),
    providerId: z.enum([
      'tavily',
      'bocha',
      'brave',
      'baidu',
      'claude',
      'minimax',
      'doubao',
      'searxng',
    ]),
    apiKey: z.string().trim().max(16_384).optional(),
    baseUrl: z.string().trim().max(2_048).optional(),
    modelId: z.string().trim().max(200).optional(),
    baiduSubSources: z
      .object({ webSearch: z.boolean(), baike: z.boolean(), scholar: z.boolean() })
      .strict()
      .optional(),
  })
  .strict();
export type GenerationSearchSnapshotContent = z.infer<typeof contentSchema>;

function key(): Buffer {
  const value = process.env.GENERATION_MODEL_ENCRYPTION_KEY?.trim();
  if (!value || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new GenerationSearchSnapshotError('GENERATION_SEARCH_ENCRYPTION_UNAVAILABLE', 503);
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

function aad(ownerId: string, ref: GenerationSearchRef): Buffer {
  return Buffer.from(JSON.stringify(['generation-search:v1', ownerId, ref.id, ref.revision]));
}

function seal(content: GenerationSearchSnapshotContent, ownerId: string, ref: GenerationSearchRef) {
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
  ref: GenerationSearchRef,
): GenerationSearchSnapshotContent {
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
    if (error instanceof GenerationSearchSnapshotError) throw error;
    throw new GenerationSearchSnapshotError('GENERATION_SEARCH_DECRYPTION_FAILED', 503);
  }
}

/** Operator-only migration helper for owner-bound search snapshot AAD/digests. */
export function reassignGenerationSearchSnapshot(
  ciphertext: string,
  fromOwnerId: string,
  toOwnerId: string,
  ref: GenerationSearchRef,
): { ciphertext: string; intentDigest: string } {
  const content = unseal(ciphertext, fromOwnerId, ref);
  return {
    ciphertext: seal(content, toOwnerId, ref),
    intentDigest: createHmac('sha256', key())
      .update(`generation-search:v1\0${toOwnerId}\0${canonical(content)}`)
      .digest('hex'),
  };
}

export function generationSearchSnapshotContent(value: unknown): GenerationSearchSnapshotContent {
  const parsed = contentSchema.safeParse(value);
  if (!parsed.success) throw new GenerationSearchSnapshotError('GENERATION_SEARCH_INVALID');
  const content = parsed.data;
  const managed = isServerConfiguredProvider('webSearch', content.providerId);
  let baseUrl: string | undefined;
  try {
    baseUrl =
      managed || content.providerId === 'searxng'
        ? undefined
        : resolveSafeClientWebSearchBaseUrl(content.providerId, content.baseUrl);
  } catch {
    throw new GenerationSearchSnapshotError('GENERATION_SEARCH_BASE_URL_UNSUPPORTED');
  }
  return {
    ...content,
    apiKey: managed ? undefined : content.apiKey || undefined,
    baseUrl,
  };
}
export class GenerationSearchSnapshotStore {
  constructor(
    private readonly db: Queryable,
    private readonly transaction: WithTransaction = async (body) => body(db),
  ) {}

  async create(ownerId: string, value: unknown): Promise<GenerationSearchRef> {
    const content = contentSchema.parse(value);
    const digest = createHmac('sha256', key())
      .update(`generation-search:v1\0${ownerId}\0${canonical(content)}`)
      .digest('hex');
    return this.transaction(async (db) => {
      const existing = await db.query<GenerationSearchRef>(
        'SELECT id,revision FROM generation_search_snapshots WHERE owner_id=$1 AND intent_digest=$2 AND revoked_at IS NULL LIMIT 1',
        [ownerId, digest],
      );
      if (existing.rows[0]) return existing.rows[0];
      const ref = { id: randomUUID(), revision: 1 };
      const inserted = await db.query<GenerationSearchRef>(
        `INSERT INTO generation_search_snapshots(id,owner_id,revision,schema_version,ciphertext,intent_digest) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id,revision`,
        [
          ref.id,
          ownerId,
          ref.revision,
          GENERATION_SEARCH_SNAPSHOT_SCHEMA_VERSION,
          seal(content, ownerId, ref),
          digest,
        ],
      );
      if (inserted.rows[0]) return inserted.rows[0];
      const raced = await db.query<GenerationSearchRef>(
        'SELECT id,revision FROM generation_search_snapshots WHERE owner_id=$1 AND intent_digest=$2 AND revoked_at IS NULL LIMIT 1',
        [ownerId, digest],
      );
      if (!raced.rows[0])
        throw new GenerationSearchSnapshotError('GENERATION_SEARCH_SNAPSHOT_UNAVAILABLE', 503);
      return raced.rows[0];
    });
  }

  async load(
    ownerId: string,
    value: GenerationSearchRef,
  ): Promise<GenerationSearchSnapshotContent> {
    const parsed = GenerationSearchRefSchema.safeParse(value);
    if (!parsed.success)
      throw new GenerationSearchSnapshotError('GENERATION_SEARCH_INVALID_REFERENCE');
    const result = await this.db.query<{ ciphertext: string; schema_version: number }>(
      `SELECT ciphertext,schema_version FROM generation_search_snapshots s
       WHERE id=$1 AND revision=$2 AND owner_id=$3
         AND (
           revoked_at IS NULL
           OR EXISTS (
             SELECT 1 FROM generation_jobs j
             WHERE j.owner_id=$3
               AND j.status NOT IN ('succeeded','failed','cancelled')
               AND j.input_snapshot->'searchConfigRef'->>'id'=$1::text
               AND (j.input_snapshot->'searchConfigRef'->>'revision')::int=$2
           )
         )`,
      [parsed.data.id, parsed.data.revision, ownerId],
    );
    const row = result.rows[0];
    if (!row || Number(row.schema_version) !== GENERATION_SEARCH_SNAPSHOT_SCHEMA_VERSION)
      throw new GenerationSearchSnapshotError('GENERATION_SEARCH_SNAPSHOT_UNAVAILABLE', 409);
    return unseal(row.ciphertext, ownerId, parsed.data);
  }

  async revoke(ownerId: string, value: GenerationSearchRef): Promise<boolean> {
    const parsed = GenerationSearchRefSchema.safeParse(value);
    if (!parsed.success)
      throw new GenerationSearchSnapshotError('GENERATION_SEARCH_INVALID_REFERENCE');
    const result = await this.db.query<{ id: string }>(
      `UPDATE generation_search_snapshots SET revoked_at=clock_timestamp()
       WHERE id=$1 AND revision=$2 AND owner_id=$3 AND revoked_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM generation_jobs j
           WHERE j.owner_id=$3
             AND j.status NOT IN ('succeeded','failed','cancelled')
             AND j.input_snapshot->'searchConfigRef'->>'id'=$1::text
             AND (j.input_snapshot->'searchConfigRef'->>'revision')::int=$2
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
        `UPDATE generation_search_snapshots s SET revoked_at=clock_timestamp()
         WHERE s.revoked_at IS NULL
           AND (
             (
               s.created_at<clock_timestamp()-$1*interval '1 millisecond'
               AND NOT EXISTS (
                 SELECT 1 FROM generation_jobs j
                 WHERE j.owner_id=s.owner_id
                   AND j.input_snapshot->'searchConfigRef'->>'id'=s.id::text
                   AND (j.input_snapshot->'searchConfigRef'->>'revision')::int=s.revision
               )
             )
             OR EXISTS (
               SELECT 1 FROM generation_jobs j
               WHERE j.owner_id=s.owner_id
                 AND j.status IN ('succeeded','failed','cancelled')
                 AND j.finished_at<clock_timestamp()-$1*interval '1 millisecond'
                 AND j.input_snapshot->'searchConfigRef'->>'id'=s.id::text
                 AND (j.input_snapshot->'searchConfigRef'->>'revision')::int=s.revision
             )
           )
           AND NOT EXISTS (
             SELECT 1 FROM generation_jobs j
             WHERE j.owner_id=s.owner_id
               AND j.input_snapshot->'searchConfigRef'->>'id'=s.id::text
               AND (j.input_snapshot->'searchConfigRef'->>'revision')::int=s.revision
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
        `DELETE FROM generation_search_snapshots s
         WHERE s.revoked_at<clock_timestamp()-$1*interval '1 millisecond'
           AND NOT EXISTS (
             SELECT 1 FROM generation_jobs j
             WHERE j.owner_id=s.owner_id
               AND j.status NOT IN ('succeeded','failed','cancelled')
               AND j.input_snapshot->'searchConfigRef'->>'id'=s.id::text
               AND (j.input_snapshot->'searchConfigRef'->>'revision')::int=s.revision
           )
         RETURNING id`,
        [retention],
      );
      return { revoked: revoked.rows.length, deleted: deleted.rows.length };
    });
  }
}

const stores = new WeakMap<object, Promise<GenerationSearchSnapshotStore>>();
async function store() {
  const connectionString = tryAgentRuntimeDatabaseUrl();
  if (!connectionString)
    throw new GenerationSearchSnapshotError('GENERATION_SEARCH_DATABASE_UNAVAILABLE', 503);
  const { pool } = await getServerPersistenceProvider(connectionString);
  let pending = stores.get(pool);
  if (!pending) {
    pending = assertGenerationSchema(pool).then(
      () => new GenerationSearchSnapshotStore(pool, nodePostgresTransaction(pool)),
    );
    stores.set(pool, pending);
    pending.catch(() => stores.delete(pool));
  }
  return pending;
}

function ownerStore(ownerId: string): GenerationSearchSnapshotStore {
  const db = createOwnerBoundQueryable(getPersistencePool(), ownerId);
  return new GenerationSearchSnapshotStore(db, db.withTransaction);
}

export async function syncGenerationSearchSnapshot(ownerId: string, value: unknown) {
  return ownerStore(ownerId).create(ownerId, value);
}
export async function loadGenerationSearchSnapshot(ownerId: string, ref: GenerationSearchRef) {
  return ownerStore(ownerId).load(ownerId, ref);
}
export async function cleanupGenerationSearchSnapshots(retentionMs: number) {
  return (await store()).cleanupExpired(retentionMs);
}
