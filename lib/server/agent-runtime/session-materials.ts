/**
 * Session-scoped web materials — host adapter.
 *
 * The durable row is stored in the package's `agent_session_materials` table
 * (create/list/read paging over `PgAgentSessionMaterialStore`, lazy-bound like
 * `store.ts` / `user-skill-store.ts`). The bytes are not kept on the row: the
 * extracted markdown is stored through the neutral material byte store and
 * the row records its object key. The package's legacy `textAssetId` and
 * `rawAssetId` field names remain as compatibility columns, but their values
 * are byte-store keys rather than registry ids.
 */
import {
  PgAgentSessionMaterialStore,
  ensureAgentSessionMaterialSchema,
} from '@openmaic/storage/material/pg';
import { createHash } from 'node:crypto';
import {
  createMaterialId,
  type AgentSessionMaterial,
  type AgentSessionMeta,
  type ListAgentSessionMaterialsOptions,
} from '@openmaic/storage';
import { getReadyOwnerMaterials } from '@/lib/persistence/owner-materials';
import {
  checkHeavyTaskAdmission,
  checkHeavyTaskAttentionCapacity,
  checkHeavyTaskQueueCapacity,
  HeavyTaskCapacityError,
  isHeavyTaskFairTurn,
} from '@/lib/server/heavy-task-admission';

import { getPersistenceDatabaseUrl, tryAgentRuntimeDatabaseUrl } from '@/lib/db/database-urls';
import { isHostedAuthEnabled } from '@/lib/auth/mode';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { createOwnerBoundQueryable } from '@/lib/db/request-queryable';
import { getMaterialByteStore } from '@/lib/server/materials/bytes';
import {
  findStudyVersionByUpload,
  readableStudySharedKey,
  recordStudySessionRef,
  type StudySessionBinding,
} from '@/lib/server/study/materials/repository';

import { getAgentSessionStore, nodePostgresTransaction } from './store';
import { agentRuntimeConfig } from './config';
import { isPptxMaterial } from './pptx-mime';
import type { ExtractedWebPage } from './fetch-url';

interface AgentSessionMaterialStoreState {
  connectionString?: string;
  storePromise?: Promise<PgAgentSessionMaterialStore>;
}

const MATERIAL_STORE_STATE_KEY = Symbol.for('openmaic.agent-session-material.store');

export class SessionMaterialBindingError extends Error {
  override readonly name = 'SessionMaterialBindingError';
}
const globalState = globalThis as typeof globalThis & {
  [MATERIAL_STORE_STATE_KEY]?: AgentSessionMaterialStoreState;
};
const storeState = (globalState[MATERIAL_STORE_STATE_KEY] ??= {});

async function createMaterialStore(
  connectionString: string,
  ownerId?: string,
): Promise<PgAgentSessionMaterialStore> {
  const { pool } = await getServerPersistenceProvider(connectionString);
  // The material table references agent_sessions(id), so the agent-session
  // schema (provisioned by getAgentSessionStore) must exist first — the same
  // dependency the URL trust-gate table has inside that schema.
  if (!isHostedAuthEnabled()) await ensureAgentSessionMaterialSchema(pool);
  const db = ownerId && isHostedAuthEnabled() ? createOwnerBoundQueryable(pool, ownerId) : pool;
  const withTransaction =
    ownerId && isHostedAuthEnabled()
      ? (db as ReturnType<typeof createOwnerBoundQueryable>).withTransaction
      : nodePostgresTransaction(pool);
  return new PgAgentSessionMaterialStore(db, {
    withTransaction,
    admitExtractionClaim: async (transaction, input): Promise<boolean> => {
      const decision = await checkHeavyTaskAdmission(transaction, {
        ownerId: input.ownerId,
        rootTaskId: `agent:${input.sessionId}`,
        kind: 'material-extraction',
        nowMs: input.now,
        agentLeaseTtlMs: agentRuntimeConfig.leaseTtlMs,
        materialLeaseTtlMs: input.leaseTtlMs,
      });
      return (
        decision.allowed &&
        (decision.inherited ||
          (await isHeavyTaskFairTurn(transaction, {
            ownerId: input.ownerId,
            rootTaskId: `agent:${input.sessionId}`,
            kind: 'material-extraction',
            nowMs: input.now,
            agentLeaseTtlMs: agentRuntimeConfig.leaseTtlMs,
            materialLeaseTtlMs: input.leaseTtlMs,
          })))
      );
    },
    admitExtractionEnqueue: async (transaction, input): Promise<boolean> => {
      const decision = await checkHeavyTaskQueueCapacity(transaction, {
        ownerId: input.ownerId,
        rootTaskId: `agent:${input.sessionId}`,
      });
      if (!decision.allowed) throw new HeavyTaskCapacityError(decision.reason);
      const attention = await checkHeavyTaskAttentionCapacity(transaction, {
        ownerId: input.ownerId,
        rootTaskId: `agent:${input.sessionId}`,
      });
      if (!attention.allowed) throw new HeavyTaskCapacityError(attention.reason);
      return true;
    },
  });
}

/**
 * Return the process-wide session-material store, initializing its schema
 * lazily. Failed initialization is cleared so a later request can retry after
 * the database becomes available.
 */
export function getAgentSessionMaterialStore(
  ownerId?: string,
): Promise<PgAgentSessionMaterialStore> {
  if (ownerId && isHostedAuthEnabled()) {
    return createMaterialStore(getPersistenceDatabaseUrl(), ownerId);
  }
  const connectionString = tryAgentRuntimeDatabaseUrl();
  if (!connectionString) {
    return Promise.reject(new Error('Agent runtime requires DATABASE_URL'));
  }
  if (storeState.storePromise && storeState.connectionString === connectionString) {
    return storeState.storePromise;
  }

  storeState.connectionString = connectionString;
  const initialization = createMaterialStore(connectionString).catch((error) => {
    if (storeState.storePromise === initialization) {
      storeState.storePromise = undefined;
      storeState.connectionString = undefined;
    }
    throw error;
  });
  storeState.storePromise = initialization;
  return initialization;
}

function sessionMaterialPrefix(sessionId: string): string {
  return `materials/${sessionId}/`;
}

function sessionMaterialKey(sessionId: string, materialId: string, name: string): string {
  return `${sessionMaterialPrefix(sessionId)}${materialId}/${name}`;
}

/** Session rows have a global id primary key, even when their source uploads match. */
function boundOwnerMaterialId(sessionId: string, ownerMaterialId: string): string {
  const digest = createHash('sha256')
    .update(sessionId)
    .update('\0')
    .update(ownerMaterialId)
    .digest();
  const alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
  let bits = 0;
  let value = 0;
  let suffix = '';
  for (const byte of digest.subarray(0, 16)) {
    value = value * 256 + byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      suffix += alphabet[(value / 2 ** bits) & 31];
      value %= 2 ** bits;
    }
  }
  if (bits > 0) suffix += alphabet[(value * 2 ** (5 - bits)) & 31];
  return `mat_${suffix}`;
}

function rawObjectName(mime: string): string {
  return `raw.${Buffer.from(mime, 'utf8').toString('base64url')}`;
}

function rawObjectMime(key: string): string {
  const encoded = key
    .split('/')
    .at(-1)
    ?.match(/^raw\.([A-Za-z0-9_-]+)$/)?.[1];
  if (!encoded) return 'application/octet-stream';
  try {
    return Buffer.from(encoded, 'base64url').toString('utf8') || 'application/octet-stream';
  } catch {
    return 'application/octet-stream';
  }
}

function isSessionMaterialKey(sessionId: string, key: string): boolean {
  return key.startsWith(sessionMaterialPrefix(sessionId));
}

/**
 * A shared study-library object (raw upload or parsed text) outside the
 * session prefix is readable only through a recorded session reference to a
 * live version of the session owner's material (learning plan B02).
 */
async function readableSharedKey(sessionId: string, key: string): Promise<{ mime: string } | null> {
  if (!key.startsWith('materials/') && !key.startsWith('study/')) return null;
  const connectionString = tryAgentRuntimeDatabaseUrl();
  if (!connectionString) return null;
  try {
    const { pool } = await getServerPersistenceProvider(connectionString);
    return await readableStudySharedKey(pool, sessionId, key);
  } catch {
    return null;
  }
}

/**
 * Bind one study-library version by reference: the session's source row points
 * at the shared upload, and when the version is already parsed a completed
 * extraction row points at the shared parsed text, so the agent neither copies
 * bytes nor re-extracts. Idempotent per (session, material row).
 */
async function bindStudyVersionToSession(
  store: PgAgentSessionMaterialStore,
  ownerDb: Parameters<typeof recordStudySessionRef>[0],
  input: {
    ownerId: string;
    sessionId: string;
    sessionMaterialId: string;
    title: string;
    version: StudySessionBinding;
  },
): Promise<void> {
  const { sessionId, sessionMaterialId, version } = input;
  if (!(await store.getMaterial(sessionId, sessionMaterialId))) {
    await store.createMaterial(sessionId, {
      id: sessionMaterialId,
      kind: 'source',
      title: input.title,
      rawAssetId: version.objectKey,
      textChars: 0,
    });
  }
  await recordStudySessionRef(ownerDb, {
    ownerId: input.ownerId,
    sessionId,
    sessionMaterialId,
    versionId: version.versionId,
    artifactId: version.artifact?.artifactId ?? null,
  });
  const artifact = version.artifact;
  if (!artifact) return;
  const derivedId = boundOwnerMaterialId(sessionId, artifact.artifactId);
  if (await store.getMaterial(sessionId, derivedId)) return;
  await store.createMaterial(sessionId, {
    id: derivedId,
    kind: 'extraction',
    title: `${input.title}.extracted.md`,
    textAssetId: artifact.textKey,
    textChars: artifact.textChars,
    derivedFrom: sessionMaterialId,
  });
  await ownerDb.query(
    `UPDATE agent_session_materials
        SET extraction_status='done', extractor_version=$3, extraction_stats=$4::jsonb
      WHERE id=$1 AND session_id=$2 AND kind='source' AND extraction_status='idle'`,
    [
      sessionMaterialId,
      sessionId,
      `${artifact.extractorId}@${artifact.extractorVersion}`,
      JSON.stringify({
        chars: artifact.textChars,
        pages: artifact.pageCount,
        imageCount: artifact.imageCount,
        ...(artifact.diagnostics.length ? { diagnostics: artifact.diagnostics } : {}),
      }),
    ],
  );
}

/**
 * Persist a fetched web page as a session material: the extracted markdown
 * goes into the byte store, the material row records the object key plus the
 * fetch's provenance (title / source URL / text character count). A confirmed
 * material-row failure removes the just-stored object. Ambiguous
 * database outcomes are verified before cleanup so a committed row never has
 * its asset removed underneath it.
 */
export async function createWebMaterial(
  sessionId: string,
  page: ExtractedWebPage,
): Promise<AgentSessionMaterial> {
  if (!tryAgentRuntimeDatabaseUrl()) throw new Error('Agent runtime requires DATABASE_URL');
  const id = createMaterialId();
  const body = Buffer.from(page.markdown, 'utf8');
  const textObjectKey = sessionMaterialKey(sessionId, id, 'text.md');
  const byteStore = getMaterialByteStore();
  // Initialize the row store before writing bytes, narrowing the non-atomic
  // byte/metadata handoff to the two business writes themselves.
  const store = await getAgentSessionMaterialStore();
  await byteStore.put(textObjectKey, body, 'text/markdown');
  try {
    return await store.createMaterial(sessionId, {
      id,
      kind: 'web',
      title: page.title.slice(0, 180) || undefined,
      sourceUrl: page.sourceUrl,
      textAssetId: textObjectKey,
      textChars: page.markdown.length,
    });
  } catch (error) {
    // A database connection can fail after PostgreSQL committed the INSERT.
    // Verify absence before compensating; otherwise cleanup could delete the
    // object underneath a durable material row. If verification itself fails,
    // preserve the object and let orphan reconciliation handle it rather than
    // risk creating a dangling row.
    const committed = await store.getMaterial(sessionId, id).catch(() => undefined);
    if (committed) return committed;
    if (committed === null) {
      await byteStore.delete(textObjectKey).catch(() => undefined);
    }
    throw error;
  }
}

/** A user-uploaded source file, persisted through the same seams as a fetch. */
export interface CreateSourceMaterialInput {
  /** Display name of the uploaded file (the `x-material-filename` header). */
  filename: string;
  /** Canonical MIME type of the uploaded bytes. */
  mimeType: string;
  /** The uploaded bytes. */
  bytes: Buffer;
}

/**
 * Persist a user-uploaded file as a session material: the raw bytes go into
 * the byte store under the session's own prefix and the material row records
 * its object key in the compatibility `rawAssetId` column. The kind is `source`,
 * the same vocabulary the reference uses for uploads: source records carry no
 * readable text by design (the agent reads extraction or image derivatives
 * instead), so `textChars` stays 0 and only `rawAssetId` is recorded. A
 * confirmed material-row failure removes the just-stored asset; ambiguous
 * database outcomes are verified before cleanup, exactly like the web path.
 */
export async function createSourceMaterial(
  sessionId: string,
  input: CreateSourceMaterialInput,
): Promise<AgentSessionMaterial> {
  if (!tryAgentRuntimeDatabaseUrl()) throw new Error('Agent runtime requires DATABASE_URL');
  const id = createMaterialId();
  const body = Buffer.from(input.bytes);
  const rawObjectKey = sessionMaterialKey(sessionId, id, rawObjectName(input.mimeType));
  const byteStore = getMaterialByteStore();
  const store = await getAgentSessionMaterialStore();
  await byteStore.put(rawObjectKey, body, input.mimeType);
  try {
    return await store.createMaterial(sessionId, {
      id,
      kind: 'source',
      title: input.filename,
      rawAssetId: rawObjectKey,
      textChars: 0,
    });
  } catch (error) {
    // Same ambiguous-commit discipline as createWebMaterial: only remove the
    // asset when the row is confirmed absent.
    const committed = await store.getMaterial(sessionId, id).catch(() => undefined);
    if (committed) return committed;
    if (committed === null) {
      await byteStore.delete(rawObjectKey).catch(() => undefined);
    }
    throw error;
  }
}

/**
 * Bind owner-library uploads to a session by copying their private bytes into
 * the session byte prefix and creating the material rows the agent reads.
 * Rebinding the same id is idempotent.
 */
export async function bindOwnerMaterialsToSession(
  sessionId: string,
  ownerId: string,
  materialIds: readonly string[],
): Promise<Array<{ materialId: string; originalName?: string; mime?: string; bytes: number }>> {
  const connectionString = isHostedAuthEnabled()
    ? getPersistenceDatabaseUrl()
    : tryAgentRuntimeDatabaseUrl();
  if (!connectionString) throw new Error('Agent runtime requires DATABASE_URL');
  const provider = await getServerPersistenceProvider(connectionString);
  const ownerDb = isHostedAuthEnabled()
    ? createOwnerBoundQueryable(provider.pool, ownerId)
    : provider.pool;
  const records = await getReadyOwnerMaterials(ownerDb, ownerId, materialIds);
  const byteStore = getMaterialByteStore();
  const byId = new Map(records.map((record) => [record.id, record]));
  if (materialIds.some((id) => !byId.has(id))) {
    throw new SessionMaterialBindingError('one or more materials are unavailable');
  }
  const store = await getAgentSessionMaterialStore(ownerId);
  const bound = [];
  for (const id of materialIds) {
    const record = byId.get(id)!;
    // Older sessions used the owner upload id directly. Keep their existing
    // binding; new sessions need a distinct globally unique material-row id.
    const legacyBinding = await store.getMaterial(sessionId, id);
    const sessionMaterialId = legacyBinding ? id : boundOwnerMaterialId(sessionId, id);
    const studyVersion = legacyBinding
      ? null
      : await findStudyVersionByUpload(ownerDb, ownerId, id).catch(() => null);
    if (studyVersion) {
      // Study library version: reference the shared bytes and parse instead
      // of copying them into the session (learning plan B02).
      await bindStudyVersionToSession(store, ownerDb, {
        ownerId,
        sessionId,
        sessionMaterialId,
        title: record.originalName ?? id,
        version: studyVersion,
      });
    } else if (!(legacyBinding ?? (await store.getMaterial(sessionId, sessionMaterialId)))) {
      let source: Buffer;
      try {
        source = await byteStore.get(record.ossKey);
      } catch {
        throw new SessionMaterialBindingError(`material ${id} bytes are unavailable`);
      }
      const mime = record.mime ?? 'application/octet-stream';
      const rawObjectKey = sessionMaterialKey(sessionId, sessionMaterialId, rawObjectName(mime));
      await byteStore.put(rawObjectKey, source, mime);
      try {
        await store.createMaterial(sessionId, {
          id: sessionMaterialId,
          kind: 'source',
          title: record.originalName ?? id,
          rawAssetId: rawObjectKey,
          textChars: 0,
        });
      } catch (error) {
        if (!(await store.getMaterial(sessionId, sessionMaterialId))) {
          await byteStore.delete(rawObjectKey).catch(() => undefined);
          throw error;
        }
      }
    }
    bound.push({
      materialId: sessionMaterialId,
      ...(record.originalName ? { originalName: record.originalName } : {}),
      ...(record.mime ? { mime: record.mime } : {}),
      bytes: record.bytes,
    });
  }
  return bound;
}

/**
 * The HTTP-visible projection of one material row — the same shape the
 * `list_materials` agent tool exposes. Object keys stay off the wire.
 */
export function publicMaterialView(record: AgentSessionMaterial): Record<string, unknown> {
  return {
    materialId: record.id,
    kind: record.kind,
    ...(record.title ? { title: record.title } : {}),
    ...(record.sourceUrl ? { sourceUrl: record.sourceUrl } : {}),
    textChars: record.textChars,
    extraction: record.extraction,
    createdAt: record.createdAt,
  };
}

/**
 * Resolve a session the owner may reach, or `null` — the materials routes'
 * ownership gate. Materials are session-scoped, so an HTTP client must name
 * the session it means; the session's own owner row is the authorization, and
 * a foreign or missing session answers the same `null` (no existence oracle).
 */
export async function resolveOwnedSession(
  sessionId: string,
  ownerId: string,
): Promise<AgentSessionMeta | null> {
  const store = await getAgentSessionStore(ownerId);
  const session = await store.getSession(sessionId);
  return session && session.ownerId === ownerId ? session : null;
}

/** Newest-first session material listing with keyset paging. */
export async function listSessionMaterials(
  sessionId: string,
  options?: ListAgentSessionMaterialsOptions,
  ownerId?: string,
): Promise<AgentSessionMaterial[]> {
  const store = await getAgentSessionMaterialStore(ownerId);
  return store.listMaterials(sessionId, options);
}

/** Session-scoped material read; foreign and nonexistent ids read as absent. */
export async function getSessionMaterial(
  sessionId: string,
  materialId: string,
  ownerId?: string,
): Promise<AgentSessionMaterial | null> {
  const store = await getAgentSessionMaterialStore(ownerId);
  return store.getMaterial(sessionId, materialId);
}

/**
 * Resolve a material's recorded text object to its bytes, or `null` when the
 * object is absent. The lookup is scoped to the session's own byte prefix, so
 * a foreign or stale `textAssetId` — even one read off another
 * session's row — resolves as a miss, never as another session's content.
 */
export async function resolveSessionMaterialText(
  sessionId: string,
  textAssetId: string,
): Promise<Buffer | null> {
  if (
    !isSessionMaterialKey(sessionId, textAssetId) &&
    !(await readableSharedKey(sessionId, textAssetId))
  )
    return null;
  try {
    return await getMaterialByteStore().get(textAssetId);
  } catch {
    return null;
  }
}

/**
 * Persist raw bytes (e.g. an uploaded audio/video source or a derived clip)
 * into the session's material byte prefix and return its object key for the
 * material row's compatibility `rawAssetId` slot.
 */
export async function storeSessionMaterialRawAsset(
  sessionId: string,
  bytes: Buffer,
  mime: string,
): Promise<string> {
  const key = sessionMaterialKey(sessionId, createMaterialId(), rawObjectName(mime));
  await getMaterialByteStore().put(key, bytes, mime);
  return key;
}

/**
 * Resolve a material row's raw bytes (audio/video source or derived clip) to
 * their bytes plus encoded media type, or `null` when the object is absent.
 * Scoped to the session's own prefix like `resolveSessionMaterialText`.
 */
export async function resolveSessionMaterialRawAsset(
  sessionId: string,
  rawAssetId: string,
): Promise<{ bytes: Buffer; mime: string } | null> {
  if (isSessionMaterialKey(sessionId, rawAssetId)) {
    try {
      return {
        bytes: await getMaterialByteStore().get(rawAssetId),
        mime: rawObjectMime(rawAssetId),
      };
    } catch {
      return null;
    }
  }
  const shared = await readableSharedKey(sessionId, rawAssetId);
  if (!shared) return null;
  try {
    return { bytes: await getMaterialByteStore().get(rawAssetId), mime: shared.mime };
  } catch {
    return null;
  }
}

/**
 * Remove a raw object from the session's material prefix (compensation for a
 * failed material-row write). A no-op for foreign keys.
 */
export async function removeSessionMaterialRawAsset(
  sessionId: string,
  rawAssetId: string,
): Promise<void> {
  if (!isSessionMaterialKey(sessionId, rawAssetId)) return;
  await getMaterialByteStore().delete(rawAssetId);
}

/**
 * Safe metadata and typed-tool guidance for materials bound to one session.
 * Material contents stay in the byte store and are available only through
 * the session-scoped material tools, never through this block.
 */
export function sessionMaterialsPromptBlock(materials: AgentSessionMaterial[]): string {
  if (materials.length === 0) return '';

  return [
    '## Registered session materials',
    '',
    'These materials are associated with this session:',
    ...materials.map(
      (material) =>
        `- "${material.title ?? material.id}" (${material.kind}, ${material.textChars} characters)`,
    ),
    '',
    'Material workflow: call `list_materials` to inspect the session materials and discover `mat_` ids; call `extract_material` on an uploaded source, then `wait_for_materials`; call `read_material` on the resulting extraction `mat_` id to read its text in pages (continue with the returned `nextOffset`); call `search_material` to locate case-insensitive literal text across the readable materials.',
    'To reuse session image, video, or audio bytes in a page, call `use_material_media` and use the returned stable `src`.',
    'A `web` material was already fetched and extracted; read it directly with `read_material` and page through offsets.',
    ...(materials.some((material) => isPptxMaterial({ originalName: material.title }))
      ? [
          'A registered .pptx can be imported INTO a stage as appended pages with `import_pptx` (layout-preserving: original slides become pages; the stage keeps its own title). Use that instead of an AI rewrite when the user wants the PowerPoint\u2019s own pages.',
        ]
      : []),
  ].join('\n');
}
