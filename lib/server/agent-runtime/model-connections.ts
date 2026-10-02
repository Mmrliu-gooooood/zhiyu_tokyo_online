import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Queryable, WithTransaction } from '@openmaic/storage/agent-session/pg';
import {
  ModelSelectionError,
  modelSelectionSchema,
  parseModelString,
  upgradeLegacyModelParams,
  type ModelSelection,
} from '@/lib/model-gateway';
import { getDescriptor } from '@/lib/model-gateway/catalog/descriptors';
import { WIRE_APIS } from '@/lib/model-gateway/selection/schema';
import { isHostedAuthEnabled } from '@/lib/auth/mode';
import { getPersistenceDatabaseUrl, tryAgentRuntimeDatabaseUrl } from '@/lib/db/database-urls';
import { getPersistencePool } from '@/lib/db/pool-registry';
import { createOwnerBoundQueryable } from '@/lib/db/request-queryable';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { PRO_MODEL_CONNECTION_SCHEMA } from './model-connection-schema';

export { PRO_MODEL_CONNECTION_SCHEMA } from './model-connection-schema';
import {
  PlatformDefaultModelError,
  isServerConfiguredProvider,
  resolvePlatformDefault,
} from '@/lib/server/provider-config';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import {
  isPlatformThinkingConfigSupported,
  normalizePlatformThinkingConfig,
} from '@/lib/server/platform-default-models';
import { nodePostgresTransaction } from './store';
import type { ProModelContext, ProModelRef } from '@/types/pro-model';

export class ProModelConnectionError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
    this.name = 'ProModelConnectionError';
  }
}

const refSchema = z.object({ id: z.uuid(), revision: z.number().int().positive() });
/** v1 revision content and the legacy flat request body (Home settings fields). */
const legacyContextSchema = z.object({
  source: z.enum(['platform', 'user', 'legacy-managed']).optional(),
  defaultId: z
    .enum(['zhiyu-default-text', 'zhiyu-default-image', 'zhiyu-default-video', 'zhiyu-default-tts'])
    .optional(),
  revision: z.string().trim().min(1).max(500).optional(),
  modelString: z
    .string()
    .trim()
    .min(3)
    .max(500)
    .regex(/^[^:/\s]+[:/].+$/)
    .optional(),
  apiKey: z.string().max(16384).optional(),
  baseUrl: z.string().trim().max(2048).optional(),
  providerType: z.enum(['openai', 'azure', 'anthropic', 'bedrock', 'google']).optional(),
  api: z.enum(WIRE_APIS).optional(),
  thinkingConfig: z
    .object({
      mode: z.enum(['default', 'disabled', 'enabled', 'auto']).optional(),
      effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
      level: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
      enabled: z.boolean().optional(),
      budgetTokens: z.number().int().nonnegative().max(1000000).optional(),
      excludeReasoningOutput: z.boolean().optional(),
    })
    .optional(),
});
type LegacyContext = z.infer<typeof legacyContextSchema>;
/** v2 revision content (plan 3.14). */
const selectionContentSchema = z
  .object({ v: z.literal(2), selection: modelSelectionSchema })
  .strict();
type StoredContent = z.infer<typeof selectionContentSchema>;

export function parseProModelRef(value: unknown): ProModelRef | undefined {
  const result = refSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

function encryptionKey(): Buffer {
  const configured = process.env.PRO_MODEL_ENCRYPTION_KEY;
  if (!configured || !/^[a-f0-9]{64}$/i.test(configured)) {
    throw new ProModelConnectionError('PRO_MODEL_ENCRYPTION_UNAVAILABLE', 503);
  }
  return Buffer.from(configured, 'hex');
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

function seal(content: unknown, ownerId: string, ref: ProModelRef): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(Buffer.from(JSON.stringify(['pro-model:v1', ownerId, ref.id, ref.revision])));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(content), 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    encrypted.toString('base64'),
  ].join('.');
}

/** Stored revision content: v2 `{ v: 2, selection }` or a v1 flat context. */
function unseal(
  ciphertext: string,
  ownerId: string,
  ref: ProModelRef,
): StoredContent | LegacyContext {
  const key = encryptionKey();
  try {
    const [version, iv, tag, encrypted, extra] = ciphertext.split('.');
    if (version !== 'v1' || extra || !iv || !tag || !encrypted) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAAD(Buffer.from(JSON.stringify(['pro-model:v1', ownerId, ref.id, ref.revision])));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    const value: unknown = JSON.parse(
      Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]).toString(
        'utf8',
      ),
    );
    return value && typeof value === 'object' && 'v' in value
      ? selectionContentSchema.parse(value)
      : legacyContextSchema.parse(value);
  } catch {
    throw new ProModelConnectionError('PRO_MODEL_DECRYPTION_FAILED', 503);
  }
}

/** Operator-only migration helper for Pro model connection owner reassignment. */
export function reassignProModelConnectionCiphertext(
  ciphertext: string,
  fromOwnerId: string,
  toOwnerId: string,
  ref: ProModelRef,
): string {
  return seal(unseal(ciphertext, fromOwnerId, ref), toOwnerId, ref);
}

/** Operator-only equality check used to make randomized re-encryption resumable. */
export function proModelConnectionCiphertextsEqual(
  leftCiphertext: string,
  rightCiphertext: string,
  ownerId: string,
  ref: ProModelRef,
): boolean {
  return (
    canonical(unseal(leftCiphertext, ownerId, ref)) ===
    canonical(unseal(rightCiphertext, ownerId, ref))
  );
}

/** Operator / test helper: the envelope for revision content of any version. */
export function sealProModelConnectionContent(
  content: StoredContent | LegacyContext,
  ownerId: string,
  ref: ProModelRef,
): string {
  return seal(content, ownerId, ref);
}

function invalidConfig(): ProModelConnectionError {
  return new ProModelConnectionError('PRO_MODEL_INVALID_CONFIG');
}

/** Legacy flat fields → selection, with the checks that need the flat form. */
function upgradeLegacyContext(context: LegacyContext): ModelSelection {
  if (context.source === 'platform') {
    if (!context.defaultId) throw invalidConfig();
    return {
      source: 'platform',
      defaultId: context.defaultId,
      ...(context.revision ? { revision: context.revision } : {}),
      ...(context.thinkingConfig ? { thinking: context.thinkingConfig } : {}),
    };
  }
  if (context.defaultId || !context.modelString) throw invalidConfig();
  const descriptor = getDescriptor(parseModelString(context.modelString).providerId);
  if (
    descriptor?.legacyProviderType &&
    context.providerType &&
    descriptor.legacyProviderType !== context.providerType
  ) {
    throw new ProModelConnectionError('PRO_MODEL_PROVIDER_TYPE_MISMATCH');
  }
  try {
    const selection = upgradeLegacyModelParams(context);
    if (!selection) throw invalidConfig();
    return selection;
  } catch (error) {
    if (error instanceof ModelSelectionError) throw invalidConfig();
    throw error;
  }
}

async function normalizeSelection(
  selection: ModelSelection,
  allowLegacyPlatformWithoutRevision: boolean,
): Promise<ModelSelection> {
  if (selection.source === 'platform') {
    try {
      const binding = resolvePlatformDefault(selection.defaultId, 'text');
      if (!selection.revision && !allowLegacyPlatformWithoutRevision) {
        throw new ProModelConnectionError('PRO_MODEL_CONNECTION_STALE', 409);
      }
      if (selection.revision && selection.revision !== binding.revision) {
        throw new ProModelConnectionError('PRO_MODEL_CONNECTION_STALE', 409);
      }
      if (
        selection.thinking &&
        !isPlatformThinkingConfigSupported(binding.parameters, selection.thinking)
      ) {
        throw invalidConfig();
      }
      const thinking = normalizePlatformThinkingConfig(
        binding.parameters,
        selection.thinking,
        binding.defaultThinkingConfig,
      );
      return {
        source: 'platform',
        defaultId: binding.defaultId,
        revision: binding.revision,
        ...(thinking ? { thinking } : {}),
      };
    } catch (error) {
      if (error instanceof ProModelConnectionError) throw error;
      if (error instanceof PlatformDefaultModelError) {
        throw new ProModelConnectionError(error.code, error.httpStatus);
      }
      throw error;
    }
  }
  const connection = selection.connection;
  const descriptor = getDescriptor(selection.providerId);
  // A custom provider needs its wire protocol.
  if (!descriptor && !(connection && 'api' in connection && connection.api)) {
    throw new ProModelConnectionError('PRO_MODEL_PROTOCOL_REQUIRED');
  }
  if (
    selection.source === 'legacy-managed' &&
    isServerConfiguredProvider('providers', selection.providerId)
  ) {
    // Browser copies never override administrator-owned credentials/endpoints.
    const { connection: _ignored, ...managed } = selection;
    return managed;
  }
  const keyed =
    connection?.auth === 'credential' ||
    (connection?.auth === 'api-key' && connection.apiKey.trim().length > 0);
  if (!descriptor?.auth.includes('none') && !keyed) {
    throw new ProModelConnectionError('PRO_MODEL_KEY_REQUIRED');
  }
  const baseUrl = connection && 'baseUrl' in connection ? connection.baseUrl : undefined;
  if (baseUrl) {
    const unsafe = await validateUrlForSSRF(baseUrl);
    if (unsafe) throw new ProModelConnectionError('PRO_MODEL_UNSAFE_ENDPOINT');
    const url = new URL(baseUrl);
    if (url.username || url.password || url.search || url.hash) {
      throw new ProModelConnectionError('PRO_MODEL_UNSAFE_ENDPOINT');
    }
  }
  return selection;
}

async function normalizeModelConnectionContextWithPolicy(
  value: unknown,
  allowLegacyPlatformWithoutRevision: boolean,
): Promise<ProModelContext> {
  let selection: ModelSelection;
  if (value && typeof value === 'object' && 'selection' in value) {
    const parsed = modelSelectionSchema.safeParse(value.selection);
    if (!parsed.success) throw invalidConfig();
    selection = parsed.data;
  } else {
    const parsed = legacyContextSchema.safeParse(value);
    if (!parsed.success) throw invalidConfig();
    selection = upgradeLegacyContext(parsed.data);
  }
  return {
    selection: await normalizeSelection(selection, allowLegacyPlatformWithoutRevision),
  };
}

/**
 * Normalize a new browser request (`{ selection }`, or the legacy flat Home
 * fields); platform selections must pin the catalog revision.
 */
export function normalizeModelConnectionContext(value: unknown): Promise<ProModelContext> {
  return normalizeModelConnectionContextWithPolicy(value, false);
}

/** Stored revision content (either version) → a re-validated connection. */
function normalizeStored(content: StoredContent | LegacyContext): Promise<ProModelContext> {
  return normalizeModelConnectionContextWithPolicy(
    'v' in content ? { selection: content.selection } : content,
    true,
  );
}

/** Repository uses injected transactions so encryption/isolation can be tested with real SQL. */
export class ProModelConnectionStore {
  constructor(
    private readonly db: Queryable,
    private readonly transaction: WithTransaction,
  ) {}

  async sync(ownerId: string, value: unknown, previous?: ProModelRef): Promise<ProModelRef> {
    encryptionKey();
    const { selection } = await normalizeModelConnectionContext(value);
    const content: StoredContent = { v: 2, selection };
    return this.transaction(async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`pro-model:${ownerId}`]);
      const existing = await db.query<{ id: string; revision: number; revoked: boolean }>(
        previous
          ? 'SELECT id, revision, revoked FROM pro_model_connections WHERE owner_id=$1 AND id=$2 FOR UPDATE'
          : 'SELECT id, revision, revoked FROM pro_model_connections WHERE owner_id=$1 AND NOT revoked ORDER BY created_at DESC LIMIT 1 FOR UPDATE',
        previous ? [ownerId, previous.id] : [ownerId],
      );
      const current = existing.rows[0];
      if (previous && (!current || current.revoked)) {
        throw new ProModelConnectionError('PRO_MODEL_CONNECTION_UNAVAILABLE', 409);
      }
      if (previous && current.revision !== previous.revision) {
        throw new ProModelConnectionError('PRO_MODEL_CONNECTION_STALE', 409);
      }
      if (current) {
        const latest = await db.query<{ ciphertext: string }>(
          'SELECT ciphertext FROM pro_model_connection_revisions WHERE connection_id=$1 AND revision=$2',
          [current.id, current.revision],
        );
        let unchanged = false;
        try {
          unchanged =
            canonical(unseal(latest.rows[0].ciphertext, ownerId, current)) === canonical(content);
        } catch (error) {
          // A deliberate deployment-key rotation invalidates old snapshots but
          // must not prevent this authenticated owner from replacing its input.
          if (
            !(error instanceof ProModelConnectionError) ||
            error.code !== 'PRO_MODEL_DECRYPTION_FAILED'
          )
            throw error;
        }
        if (unchanged) {
          return { id: current.id, revision: current.revision };
        }
      }
      const ref = { id: current?.id ?? randomUUID(), revision: (current?.revision ?? 0) + 1 };
      const ciphertext = seal(content, ownerId, ref);
      if (current) {
        await db.query('UPDATE pro_model_connections SET revision=$2 WHERE id=$1', [
          ref.id,
          ref.revision,
        ]);
      } else {
        await db.query(
          'INSERT INTO pro_model_connections(id,owner_id,revision) VALUES ($1,$2,$3)',
          [ref.id, ownerId, ref.revision],
        );
      }
      await db.query(
        'INSERT INTO pro_model_connection_revisions(connection_id,revision,ciphertext) VALUES ($1,$2,$3)',
        [ref.id, ref.revision, ciphertext],
      );
      return ref;
    });
  }

  async assertActive(ownerId: string, ref: ProModelRef): Promise<void> {
    const result = await this.db.query(
      'SELECT 1 FROM pro_model_connections c JOIN pro_model_connection_revisions r ON r.connection_id=c.id WHERE c.id=$1 AND c.owner_id=$2 AND NOT c.revoked AND r.revision=$3',
      [ref.id, ownerId, ref.revision],
    );
    if (!result.rows.length)
      throw new ProModelConnectionError('PRO_MODEL_CONNECTION_UNAVAILABLE', 409);
  }

  async load(ownerId: string, ref: ProModelRef): Promise<ProModelContext> {
    if (!parseProModelRef(ref)) throw new ProModelConnectionError('PRO_MODEL_INVALID_REFERENCE');
    const result = await this.db.query<{ ciphertext: string }>(
      'SELECT r.ciphertext FROM pro_model_connections c JOIN pro_model_connection_revisions r ON r.connection_id=c.id WHERE c.id=$1 AND c.owner_id=$2 AND NOT c.revoked AND r.revision=$3',
      [ref.id, ownerId, ref.revision],
    );
    if (!result.rows[0]) throw new ProModelConnectionError('PRO_MODEL_CONNECTION_UNAVAILABLE', 409);
    const { selection } = await normalizeStored(unseal(result.rows[0].ciphertext, ownerId, ref));
    return { selection, assertActive: () => this.assertActive(ownerId, ref) };
  }

  async revoke(ownerId: string, id?: string): Promise<void> {
    if (id && !z.uuid().safeParse(id).success)
      throw new ProModelConnectionError('PRO_MODEL_INVALID_REFERENCE');
    await this.transaction(async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`pro-model:${ownerId}`]);
      await db.query(
        'UPDATE pro_model_connections SET revoked=true WHERE owner_id=$1 AND ($2::uuid IS NULL OR id=$2)',
        [ownerId, id ?? null],
      );
      // Crypto material is removed as well as marking references unusable.
      await db.query(
        'DELETE FROM pro_model_connection_revisions r USING pro_model_connections c WHERE r.connection_id=c.id AND c.owner_id=$1 AND c.revoked',
        [ownerId],
      );
    });
  }
}

const initializations = new WeakMap<object, Promise<ProModelConnectionStore>>();

async function getStore(ownerId: string, system = false): Promise<ProModelConnectionStore> {
  if (isHostedAuthEnabled() && !system) {
    getPersistenceDatabaseUrl();
    const db = createOwnerBoundQueryable(getPersistencePool(), ownerId);
    // The migration owns schema creation. Web requests receive only an
    // owner-bound DML surface and cannot fall back to the worker role.
    return new ProModelConnectionStore(db, db.withTransaction);
  }
  const connectionString = tryAgentRuntimeDatabaseUrl();
  if (!connectionString) throw new ProModelConnectionError('PRO_MODEL_DATABASE_UNAVAILABLE', 503);
  const { pool } = await getServerPersistenceProvider(connectionString);
  if (isHostedAuthEnabled()) {
    // Hosted worker credentials are intentionally DML-only. Migration v10
    // provisions this schema before the worker is connected.
    return new ProModelConnectionStore(pool, nodePostgresTransaction(pool));
  }
  let pending = initializations.get(pool);
  if (!pending) {
    pending = nodePostgresTransaction(pool)(async (db) => {
      // Web and runner processes may initialize simultaneously on first deploy.
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['pro-model-schema:v1']);
      await db.query(PRO_MODEL_CONNECTION_SCHEMA);
      return new ProModelConnectionStore(pool, nodePostgresTransaction(pool));
    });
    initializations.set(pool, pending);
    pending.catch(() => initializations.delete(pool));
  }
  return pending;
}

export async function syncModelConnection(ownerId: string, context: unknown, ref?: ProModelRef) {
  return (await getStore(ownerId)).sync(ownerId, context, ref);
}
export async function loadModelConnection(ownerId: string, ref: ProModelRef) {
  return (await getStore(ownerId)).load(ownerId, ref);
}
export async function loadModelConnectionForWorker(ownerId: string, ref: ProModelRef) {
  return (await getStore(ownerId, true)).load(ownerId, ref);
}
export const resolveProModelContext = loadModelConnection;
export const loadProModelContext = loadModelConnection;
export async function revokeModelConnections(ownerId: string, id?: string) {
  return (await getStore(ownerId)).revoke(ownerId, id);
}
