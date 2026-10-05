/**
 * Study material library services (learning plan B02): parser choice, upload
 * into the library, parse requests, the authorized reader and permanent
 * deletion. Route handlers validate input and call these; the worker-side
 * parse lives in ./parse.ts.
 */
import { getDocumentExtractorProviders } from '@/lib/document/extractors/registry';
import { getServerPDFProviders } from '@/lib/server/provider-config';
import { getMaterialByteStore } from '@/lib/server/materials/bytes';
import {
  discardOwnerMaterialUpload,
  storeOwnerMaterialUpload,
  type OwnerUploadState,
} from '@/lib/server/materials/owner-upload';
import { agentRuntimeConfig } from '@/lib/server/agent-runtime/config';
import { isStudyTaskIntakeOpen } from '@/lib/server/study/flags';
import { StudyError, type StudyDb } from '@/lib/server/study/spaces/repository';
import { LearningTaskError, type LearningTaskView } from '@/lib/server/learning-tasks/contracts';
import {
  enqueueLearningTask,
  isLearningTaskWorkerLive,
  listLearningTasksForSubjects,
} from '@/lib/server/learning-tasks/repository';
import {
  STUDY_MATERIAL_LIMITS,
  isStudyMaterialMime,
  type MaterialParserOption,
  type ReaderPageView,
  type StudyMaterialUploadResult,
} from '@/lib/study/materials/contracts';

import { readerBlocksForPage, type StoredArtifactDocument } from './artifact';
import {
  addStudyMaterialVersion,
  beginStudyMaterialPurge,
  createStudyMaterialFromUpload,
  finishStudyMaterialPurge,
  getStudyMaterial,
  resolveStudyVersion,
  type ResolvedStudyVersion,
} from './repository';

/** Paid external parsers: only ever used when the user explicitly chooses them. */
const PAID_PARSERS = new Set(['mineru-cloud', 'alidocmind']);
/** Local parsers that need no server configuration. */
const BUILT_IN_PARSERS = new Set(['plain-text', 'unpdf']);

/** Parsers for one file type, in registry order, with availability on this server. */
export function materialParserOptions(mime: string): MaterialParserOption[] {
  const configured = getServerPDFProviders();
  const options = getDocumentExtractorProviders()
    .filter((provider) => provider.supportedMimeTypes.includes(mime.toLowerCase()))
    .map((provider) => ({
      providerId: provider.id,
      displayName: provider.displayName,
      capabilities: {
        ocr: provider.capabilities.ocr,
        tables: provider.capabilities.tables,
        formulas: provider.capabilities.formulas,
        layout: provider.capabilities.layout,
      },
      paid: PAID_PARSERS.has(provider.id),
      available: BUILT_IN_PARSERS.has(provider.id) || provider.id in configured,
      isDefault: false,
    }));
  const preferred =
    options.find((option) => option.available && BUILT_IN_PARSERS.has(option.providerId)) ??
    options.find((option) => option.available && !option.paid);
  return options.map((option) => ({ ...option, isDefault: option === preferred }));
}

function chooseParser(mime: string, providerId: string | undefined): MaterialParserOption {
  const options = materialParserOptions(mime);
  const choice = providerId
    ? options.find((option) => option.providerId === providerId)
    : options.find((option) => option.isDefault);
  if (!choice || !choice.available) throw new StudyError('STUDY_PARSER_UNAVAILABLE');
  return choice;
}

async function assertTaskIntake(db: StudyDb): Promise<void> {
  if (!isStudyTaskIntakeOpen() || !(await isLearningTaskWorkerLive(db))) {
    throw new StudyError('STUDY_TASKS_UNAVAILABLE');
  }
}

/**
 * Queue a parse of one version with the chosen (or default free) parser.
 * A live task for the version is returned instead of starting a second one.
 */
export async function requestMaterialParse(
  db: StudyDb,
  ownerId: string,
  materialId: string,
  versionId: string,
  options: { providerId?: string; idempotencyKey?: string } = {},
): Promise<{ task: LearningTaskView; created: boolean }> {
  const version = await resolveStudyVersion(db, ownerId, materialId, versionId);
  const parser = chooseParser(version.mime, options.providerId);
  const [latest] = await listLearningTasksForSubjects(db, ownerId, [versionId], 1);
  if (latest && ['queued', 'running', 'retry_wait'].includes(latest.status)) {
    return { task: latest, created: false };
  }
  await assertTaskIntake(db);
  return db.withTransaction((tx) =>
    enqueueLearningTask(tx, {
      ownerId,
      kind: 'material_parse',
      subjectId: versionId,
      idempotencyKey:
        options.idempotencyKey ?? `parse:${versionId}:${parser.providerId}:${Date.now()}`,
      input: {
        materialId,
        providerId: parser.providerId,
        ...(parser.paid ? { externalCost: true } : {}),
      },
    }),
  );
}

export interface StudyUploadOptions {
  mime: string;
  /** Add a version to this material instead of creating a new one. */
  materialId?: string;
  spaceId?: string;
  title?: string;
  /** Parse right after upload with the default free parser (or `providerId`). */
  parse?: boolean;
  providerId?: string;
  state: OwnerUploadState;
  warn: (message: string, extra?: Record<string, unknown>, error?: unknown) => void;
}

/**
 * Store one file through the shared owner-upload pipeline (same MIME, size,
 * quota and private byte store as workbench uploads), attach it to the
 * library, then try to queue its parse. A failed attach removes the upload; a
 * parse that cannot be queued leaves the file stored and reports why.
 */
export async function uploadStudyMaterial(
  req: Request,
  ownerId: string,
  db: StudyDb,
  options: StudyUploadOptions,
): Promise<StudyMaterialUploadResult> {
  if (!isStudyMaterialMime(options.mime)) throw new StudyError('STUDY_MATERIAL_TYPE_UNSUPPORTED');
  if (options.materialId) {
    // Fail fast before any bytes are accepted.
    await getStudyMaterial(db, ownerId, options.materialId);
  }
  const upload = await storeOwnerMaterialUpload(req, ownerId, {
    mime: options.mime,
    uploadLimit: Math.min(agentRuntimeConfig.maxDocumentBytes, agentRuntimeConfig.maxUploadBytes),
    state: options.state,
    warn: options.warn,
  });
  options.state.phase = 'attach_study_material';
  let attached: Awaited<ReturnType<typeof createStudyMaterialFromUpload>>;
  try {
    attached = options.materialId
      ? await addStudyMaterialVersion(db, ownerId, options.materialId, upload)
      : await createStudyMaterialFromUpload(db, ownerId, {
          upload,
          ...(options.title ? { title: options.title } : {}),
          ...(options.spaceId ? { spaceId: options.spaceId } : {}),
        });
  } catch (error) {
    await discardOwnerMaterialUpload(ownerId, upload).catch((cleanupError) =>
      options.warn('study material upload cleanup failed', {}, cleanupError),
    );
    throw error;
  }
  let parseNotStarted: string | null = null;
  if (options.parse !== false) {
    options.state.phase = 'queue_parse';
    try {
      await requestMaterialParse(db, ownerId, attached.material.materialId, attached.versionId, {
        ...(options.providerId ? { providerId: options.providerId } : {}),
        idempotencyKey: `parse:${attached.versionId}:upload`,
      });
    } catch (error) {
      if (error instanceof StudyError || error instanceof LearningTaskError) {
        parseNotStarted = error.code;
      } else {
        throw error;
      }
    }
  }
  return {
    material: await getStudyMaterial(db, ownerId, attached.material.materialId),
    versionId: attached.versionId,
    duplicateOf: attached.duplicateOf,
    parseNotStarted,
  };
}

/**
 * Permanent delete. Reads are revoked first (phase one commits before any
 * object is touched); objects are deleted next; rows go last. A partial
 * failure leaves the material hidden in `deleting` state and the same call
 * resumes it.
 */
export async function purgeStudyMaterial(
  db: StudyDb,
  ownerId: string,
  materialId: string,
): Promise<{ deleted: boolean; pendingObjects: number }> {
  const plan = await beginStudyMaterialPurge(db, ownerId, materialId);
  const store = getMaterialByteStore();
  let pending = 0;
  for (const key of new Set(plan.objectKeys)) {
    try {
      await store.delete(key);
    } catch {
      pending += 1;
    }
  }
  if (pending > 0) return { deleted: false, pendingObjects: pending };
  await finishStudyMaterialPurge(db, ownerId, materialId, plan);
  return { deleted: true, pendingObjects: 0 };
}

// ── reader ────────────────────────────────────────────────────────────────

const ARTIFACT_CACHE_LIMIT = 16;
const artifactCache = new Map<string, StoredArtifactDocument>();

async function loadArtifactDocument(key: string): Promise<StoredArtifactDocument> {
  const cached = artifactCache.get(key);
  if (cached) {
    artifactCache.delete(key);
    artifactCache.set(key, cached);
    return cached;
  }
  let document: StoredArtifactDocument;
  try {
    document = JSON.parse((await getMaterialByteStore().get(key)).toString('utf8'));
  } catch {
    throw new StudyError('STUDY_MATERIAL_UNAVAILABLE');
  }
  artifactCache.set(key, document);
  if (artifactCache.size > ARTIFACT_CACHE_LIMIT) {
    artifactCache.delete(artifactCache.keys().next().value!);
  }
  return document;
}

function requireArtifact(version: ResolvedStudyVersion) {
  if (!version.artifact) throw new StudyError('STUDY_MATERIAL_NOT_PARSED');
  return version.artifact;
}

/** Parsed blocks of one page (paged artifacts) or of the whole text (unpaged). */
export async function readStudyMaterialPage(
  db: StudyDb,
  ownerId: string,
  input: { materialId: string; versionId: string; page?: number; artifactId?: string },
): Promise<ReaderPageView> {
  const version = await resolveStudyVersion(
    db,
    ownerId,
    input.materialId,
    input.versionId,
    input.artifactId,
  );
  const artifact = requireArtifact(version);
  const document = await loadArtifactDocument(artifact.artifactKey);
  const page = document.paged
    ? Math.min(Math.max(1, Math.trunc(input.page ?? 1)), Math.max(1, document.pageCount))
    : null;
  const { blocks, truncated } = readerBlocksForPage(
    document,
    page,
    STUDY_MATERIAL_LIMITS.maxTextChars,
  );
  return {
    materialId: version.materialId,
    versionId: version.versionId,
    versionNo: version.versionNo,
    title: version.title,
    originalName: version.originalName,
    mime: version.mime,
    isCurrent: version.isCurrent,
    artifactId: artifact.artifactId,
    extractorId: artifact.extractorId,
    paged: document.paged,
    pageCount: document.pageCount,
    page,
    blocks,
    truncated,
  };
}

/** One image extracted by the parse, only if the artifact lists it. */
export async function readStudyMaterialImage(
  db: StudyDb,
  ownerId: string,
  input: { materialId: string; versionId: string; imageId: string; artifactId?: string },
): Promise<{ bytes: Buffer; mime: string }> {
  const version = await resolveStudyVersion(
    db,
    ownerId,
    input.materialId,
    input.versionId,
    input.artifactId,
  );
  const document = await loadArtifactDocument(requireArtifact(version).artifactKey);
  const image = document.images.find((candidate) => candidate.id === input.imageId);
  if (!image) throw new StudyError('STUDY_MATERIAL_NOT_FOUND');
  try {
    return { bytes: await getMaterialByteStore().get(image.key), mime: image.mimeType };
  } catch {
    throw new StudyError('STUDY_MATERIAL_UNAVAILABLE');
  }
}

/** The reusable parsed text (what course generation and agent sessions read). */
export async function readStudyMaterialText(
  db: StudyDb,
  ownerId: string,
  input: { materialId: string; versionId: string },
): Promise<{ version: ResolvedStudyVersion; text: string; truncated: boolean }> {
  const version = await resolveStudyVersion(db, ownerId, input.materialId, input.versionId);
  const artifact = requireArtifact(version);
  let text: string;
  try {
    text = (await getMaterialByteStore().get(artifact.textKey)).toString('utf8');
  } catch {
    throw new StudyError('STUDY_MATERIAL_UNAVAILABLE');
  }
  const truncated = text.length > STUDY_MATERIAL_LIMITS.maxTextChars;
  return {
    version,
    text: truncated ? text.slice(0, STUDY_MATERIAL_LIMITS.maxTextChars) : text,
    truncated,
  };
}

/** The original uploaded bytes of one version. */
export async function readStudyMaterialFile(
  db: StudyDb,
  ownerId: string,
  input: { materialId: string; versionId: string },
): Promise<{ version: ResolvedStudyVersion; bytes: Buffer }> {
  const version = await resolveStudyVersion(db, ownerId, input.materialId, input.versionId);
  try {
    return { version, bytes: await getMaterialByteStore().get(version.objectKey) };
  } catch {
    throw new StudyError('STUDY_MATERIAL_UNAVAILABLE');
  }
}
