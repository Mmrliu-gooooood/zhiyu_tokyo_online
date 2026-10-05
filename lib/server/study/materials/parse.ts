/**
 * Worker handler for `material_parse` learning tasks (learning plan B02).
 *
 * Runs only the parser the task names — the free default or the one the user
 * picked — through the existing extractor registry (unpdf, plain text,
 * MinerU, MinerU Cloud, AliDocMind). It never falls through to another,
 * possibly paid, parser. The result is normalized, written to the private
 * material byte store and registered in one lease-fenced commit; if the lease
 * was lost or the material was deleted meanwhile, the staged objects are
 * removed again. Their keys are recorded on the attempt before any is written,
 * so if this process dies first the queue's sweep removes them later. A version that already has an artifact with the same
 * fingerprint is reused without parsing.
 */
import { createHash } from 'node:crypto';

import type { Queryable } from '@openmaic/storage/document/pg';

import { getDocumentExtractorProvider } from '@/lib/document/extractors/registry';
import type { DocumentArtifact, DocumentExtractorProvider } from '@/lib/document/types';
import { getMaterialByteStore, type MaterialByteStore } from '@/lib/server/materials/bytes';
import { isTransientExtractionError } from '@/lib/server/material-extraction/errors';
import {
  getServerPDFProviders,
  resolvePDFApiKey,
  resolvePDFBaseUrl,
} from '@/lib/server/provider-config';
import type { LearningTaskLease } from '@/lib/server/learning-tasks/contracts';
import type { LearningTaskHandlerContext } from '@/lib/server/learning-tasks/runner';

import {
  normalizeDocumentArtifact,
  studyArtifactFingerprint,
  studyArtifactPrefix,
  type StoredArtifactDocument,
} from './artifact';
import { createStudyArtifactId } from './repository';

const BUILT_IN = new Set(['plain-text', 'unpdf']);

class ParseFailure extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    message = code,
  ) {
    super(message);
    this.name = 'ParseFailure';
  }
}

class MaterialGone extends Error {}

interface VersionFacts extends Record<string, unknown> {
  id: string;
  owner_id: string;
  material_id: string;
  object_key: string;
  sha256: string;
  mime: string;
  byte_size: number | string;
  original_name: string;
  material_status: string;
}

export interface MaterialParseDependencies {
  byteStore?: () => MaterialByteStore;
  provider?: (providerId: string) => DocumentExtractorProvider | undefined;
  configuredProviders?: () => Record<string, unknown>;
  /** Development-only artificial delay to exercise cancel/drain/crash recovery. */
  delayMs?: number;
}

function devDelayMs(): number {
  if (process.env.NODE_ENV === 'production') return 0;
  const value = Number(process.env.STUDY_PARSE_DEV_DELAY_MS ?? 0);
  return Number.isSafeInteger(value) && value > 0 && value <= 120_000 ? value : 0;
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

async function readVersion(q: Queryable, lease: LearningTaskLease): Promise<VersionFacts | null> {
  const result = await q.query<VersionFacts>(
    `SELECT v.id, v.owner_id, v.material_id, v.object_key, v.sha256, v.mime, v.byte_size,
            v.original_name, m.status AS material_status
       FROM study_material_versions v
       JOIN study_materials m ON m.owner_id=v.owner_id AND m.id=v.material_id
      WHERE v.owner_id=$1 AND v.id=$2`,
    [lease.ownerId, lease.subjectId],
  );
  return result.rows[0] ?? null;
}

/** Lock the version for the result commit and require its material to be live. */
async function lockLiveVersion(q: Queryable, lease: LearningTaskLease): Promise<void> {
  const version = await q.query<{ material_id: string }>(
    'SELECT material_id FROM study_material_versions WHERE owner_id=$1 AND id=$2 FOR UPDATE',
    [lease.ownerId, lease.subjectId],
  );
  if (!version.rows[0]) throw new MaterialGone();
  const material = await q.query<{ status: string }>(
    'SELECT status FROM study_materials WHERE owner_id=$1 AND id=$2',
    [lease.ownerId, version.rows[0].material_id],
  );
  if (material.rows[0]?.status !== 'active') throw new MaterialGone();
}

export async function runMaterialParseTask(
  lease: LearningTaskLease,
  { queue, signal }: LearningTaskHandlerContext,
  deps: MaterialParseDependencies = {},
): Promise<void> {
  const byteStore = (deps.byteStore ?? getMaterialByteStore)();
  const providerId = typeof lease.input.providerId === 'string' ? lease.input.providerId : '';
  const version = await queue.transaction((q) => readVersion(q, lease));
  if (!version || version.material_status !== 'active') {
    await queue.fail(lease, { code: 'MATERIAL_DELETED', retryable: false });
    return;
  }
  const provider = (deps.provider ?? getDocumentExtractorProvider)(providerId);
  if (!provider || !provider.supportedMimeTypes.includes(version.mime.toLowerCase())) {
    await queue.fail(lease, { code: 'MATERIAL_TYPE_UNSUPPORTED', retryable: false, providerId });
    return;
  }
  const configured = (deps.configuredProviders ?? getServerPDFProviders)();
  if (!BUILT_IN.has(provider.id) && !(provider.id in configured)) {
    await queue.fail(lease, { code: 'PARSER_UNAVAILABLE', retryable: false, providerId });
    return;
  }

  const fingerprint = studyArtifactFingerprint({
    sha256: version.sha256,
    extractorId: provider.id,
    extractorVersion: provider.version,
  });
  const reused = await queue.transaction(async (q) => {
    const existing = await q.query<{ id: string; page_count: number; text_chars: number }>(
      `SELECT id, page_count, text_chars FROM study_material_artifacts
        WHERE owner_id=$1 AND version_id=$2 AND fingerprint=$3`,
      [lease.ownerId, lease.subjectId, fingerprint],
    );
    return existing.rows[0] ?? null;
  });
  if (reused) {
    await queue
      .complete(
        lease,
        {
          result: {
            artifactId: reused.id,
            reused: true,
            pageCount: Number(reused.page_count),
            textChars: Number(reused.text_chars),
          },
          providerId: provider.id,
          usageCompleteness: 'none',
        },
        async (q) => {
          await lockLiveVersion(q, lease);
          await q.query(
            'UPDATE study_material_versions SET active_artifact_id=$3 WHERE owner_id=$1 AND id=$2',
            [lease.ownerId, lease.subjectId, reused.id],
          );
        },
      )
      .catch(async (error) => {
        if (!(error instanceof MaterialGone)) throw error;
        await queue.fail(lease, { code: 'MATERIAL_DELETED', retryable: false });
      });
    return;
  }

  const startedAt = Date.now();
  await sleep(deps.delayMs ?? devDelayMs(), signal);
  let bytes: Buffer;
  try {
    bytes = await byteStore.get(version.object_key);
  } catch (error) {
    throw new ParseFailure('MATERIAL_BYTES_UNAVAILABLE', true, String(error));
  }
  if (createHash('sha256').update(bytes).digest('hex') !== version.sha256) {
    throw new ParseFailure('MATERIAL_DIGEST_MISMATCH', false);
  }

  let artifact: DocumentArtifact;
  try {
    artifact = await provider.extract({
      buffer: bytes,
      fileName: version.original_name,
      fileSize: bytes.byteLength,
      mimeType: version.mime,
      config: {
        providerId: provider.id,
        apiKey: resolvePDFApiKey(provider.id) || undefined,
        baseUrl: resolvePDFBaseUrl(provider.id),
        allowEnvFallback: true,
        pageTexts: true,
      },
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw new ParseFailure(
      'PARSER_FAILED',
      isTransientExtractionError(error),
      error instanceof Error ? error.message : String(error),
    );
  }
  signal.throwIfAborted();

  const normalized = normalizeDocumentArtifact(artifact, {
    id: provider.id,
    version: provider.version,
  });
  const usage = {
    pages: normalized.document.pageCount,
    chars: normalized.text.length,
    images: normalized.images.length,
    bytes: bytes.byteLength,
    durationMs: Date.now() - startedAt,
  };
  const paid = lease.input.externalCost === true;
  if (!normalized.text.trim()) {
    // No usable text: typically a scan (images only) read by a non-OCR parser.
    await queue.fail(lease, {
      code: 'MATERIAL_NO_TEXT',
      retryable: false,
      summary: provider.capabilities.ocr
        ? 'The parser returned no text.'
        : 'No text layer found; the file may be a scan. Choose an OCR parser if one is configured.',
      providerId: provider.id,
      usage,
      usageCompleteness: paid ? 'partial' : 'none',
    });
    return;
  }

  const artifactId = createStudyArtifactId();
  const prefix = studyArtifactPrefix(lease.ownerId, artifactId);
  const imageKey = (image: (typeof normalized.images)[number]) =>
    `${prefix}images/${image.id}.${image.mimeType.split('/')[1] ?? 'bin'}`;
  const artifactKey = `${prefix}artifact.json`;
  const textKey = `${prefix}text.md`;
  // Write-ahead: record every key before writing any, so the queue's sweep can
  // remove them if this attempt dies before the commit below makes them reachable.
  await queue.stageObjects(lease, [...normalized.images.map(imageKey), artifactKey, textKey]);
  const written: string[] = [];
  const put = async (key: string, body: Buffer, mime: string) => {
    written.push(key);
    await byteStore.put(key, body, mime);
  };
  const discard = async () => {
    const results = await Promise.allSettled(written.map((key) => byteStore.delete(key)));
    // A failed delete keeps the keys staged for the sweep to retry.
    if (results.every((result) => result.status === 'fulfilled')) {
      await queue.clearStagedObjects(null, lease.attemptId).catch(() => undefined);
    }
  };

  // Staged objects stay only when this attempt's artifact row was committed.
  let keepStaged = false;
  try {
    const images = [];
    for (const image of normalized.images) {
      signal.throwIfAborted();
      const key = imageKey(image);
      await put(key, image.bytes, image.mimeType);
      images.push({
        id: image.id,
        key,
        mimeType: image.mimeType,
        ...(image.pageNumber !== undefined ? { pageNumber: image.pageNumber } : {}),
        ...(image.width !== undefined ? { width: image.width } : {}),
        ...(image.height !== undefined ? { height: image.height } : {}),
        ...(image.description !== undefined ? { description: image.description } : {}),
      });
    }
    const document: StoredArtifactDocument = { ...normalized.document, images };
    await put(artifactKey, Buffer.from(JSON.stringify(document), 'utf8'), 'application/json');
    await put(textKey, Buffer.from(normalized.text, 'utf8'), 'text/markdown');
    signal.throwIfAborted();

    let storedId = artifactId;
    const committed = await queue.complete(
      lease,
      {
        result: {
          artifactId,
          pageCount: document.pageCount,
          textChars: normalized.text.length,
          imageCount: images.length,
          paged: document.paged,
        },
        providerId: provider.id,
        usage,
        usageCompleteness: paid ? 'partial' : 'none',
      },
      async (q) => {
        await lockLiveVersion(q, lease);
        const inserted = await q.query<{ id: string }>(
          `INSERT INTO study_material_artifacts
             (id, owner_id, version_id, fingerprint, extractor_id, extractor_version,
              transform_version, artifact_key, text_key, object_keys, page_count, block_count,
              text_chars, image_count, paged, diagnostics, task_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16::jsonb,$17)
           ON CONFLICT (owner_id, version_id, fingerprint) DO NOTHING
           RETURNING id`,
          [
            artifactId,
            lease.ownerId,
            lease.subjectId,
            fingerprint,
            provider.id,
            provider.version,
            document.transform,
            artifactKey,
            textKey,
            JSON.stringify(written),
            document.pageCount,
            document.blocks.length,
            normalized.text.length,
            images.length,
            document.paged,
            JSON.stringify(document.diagnostics),
            lease.taskId,
          ],
        );
        if (inserted.rows[0]) {
          // Reachable from the artifact row now: no longer this attempt's garbage.
          await queue.clearStagedObjects(q, lease.attemptId);
        } else {
          const existing = await q.query<{ id: string }>(
            `SELECT id FROM study_material_artifacts
              WHERE owner_id=$1 AND version_id=$2 AND fingerprint=$3`,
            [lease.ownerId, lease.subjectId, fingerprint],
          );
          storedId = existing.rows[0]!.id;
        }
        await q.query(
          'UPDATE study_material_versions SET active_artifact_id=$3 WHERE owner_id=$1 AND id=$2',
          [lease.ownerId, lease.subjectId, storedId],
        );
      },
    );
    // A concurrent identical parse may have won the unique key; then our copy is redundant.
    keepStaged = committed && storedId === artifactId;
  } catch (error) {
    if (error instanceof MaterialGone) {
      await discard();
      await queue.fail(lease, {
        code: 'MATERIAL_DELETED',
        retryable: false,
        providerId: provider.id,
        usage,
        usageCompleteness: paid ? 'partial' : 'none',
      });
      return;
    }
    await discard();
    throw error;
  }
  if (!keepStaged) await discard();
}

export { ParseFailure as MaterialParseFailure };
