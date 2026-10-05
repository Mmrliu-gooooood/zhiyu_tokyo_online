/**
 * Normalized, persistable parse artifact for study material versions
 * (learning plan B02).
 *
 * The extractor registry returns a DocumentArtifact that may carry the
 * provider's raw response, inline base64 images and parser-specific HTML.
 * What is stored is deliberately smaller and stable:
 * - blocks with id/type/text/page/bbox and an allow-listed metadata subset
 *   (table cells, layout type); no providerRaw, no HTML, no credentials;
 * - images as separate private objects referenced by id;
 * - per-page text blocks when the parser can address pages (unpdf via its
 *   opt-in `pageTexts`; MinerU/AliDocMind via page-numbered layout blocks);
 * - the reusable plain text exactly as the generation/session paths build it
 *   (text and markdown blocks joined), so reuse never changes their input.
 *
 * The fingerprint names one (file bytes, parser identity, normalization)
 * combination; it is the uniqueness key for reusing an existing artifact.
 */
import { createHash } from 'node:crypto';

import type { DocumentArtifact, DocumentBlock } from '@/lib/document/types';
import type { ReaderBlock } from '@/lib/study/materials/contracts';

export const STUDY_ARTIFACT_TRANSFORM_VERSION = 'study-artifact-v1';
export const MAX_ARTIFACT_IMAGES = 200;
export const MAX_ARTIFACT_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_DIAGNOSTICS = 20;

export interface StoredArtifactImage {
  id: string;
  key: string;
  mimeType: string;
  pageNumber?: number;
  width?: number;
  height?: number;
  description?: string;
}

export interface StoredArtifactBlock extends ReaderBlock {
  /** Table cells (string matrix) for table blocks. */
  cells?: string[][];
  layoutType?: string;
}

/** The JSON document stored at artifact_key. */
export interface StoredArtifactDocument {
  version: 1;
  transform: typeof STUDY_ARTIFACT_TRANSFORM_VERSION;
  extractorId: string;
  extractorVersion: string;
  mimeType: string;
  pageCount: number;
  paged: boolean;
  blocks: StoredArtifactBlock[];
  images: StoredArtifactImage[];
  diagnostics: string[];
}

export interface PendingArtifactImage extends Omit<StoredArtifactImage, 'key'> {
  bytes: Buffer;
}

export interface NormalizedArtifact {
  document: Omit<StoredArtifactDocument, 'images'>;
  images: PendingArtifactImage[];
  /** Reusable plain text (text/markdown blocks joined like every existing consumer). */
  text: string;
}

export function studyArtifactFingerprint(input: {
  sha256: string;
  extractorId: string;
  extractorVersion: string;
}): string {
  return createHash('sha256')
    .update(
      `${input.sha256}\n${input.extractorId}@${input.extractorVersion}\n${STUDY_ARTIFACT_TRANSFORM_VERSION}`,
    )
    .digest('hex');
}

export function studyArtifactPrefix(ownerId: string, artifactId: string): string {
  return `study/${ownerId}/artifacts/${artifactId}/`;
}

function decodeDataUrl(
  data: string,
  fallbackMime?: string,
): { bytes: Buffer; mime: string } | null {
  const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(data);
  if (match) {
    if (!match[2]) return null;
    return {
      bytes: Buffer.from(match[3], 'base64'),
      mime: match[1] || fallbackMime || 'image/png',
    };
  }
  if (/^[A-Za-z0-9+/=\s]+$/.test(data)) {
    return { bytes: Buffer.from(data, 'base64'), mime: fallbackMime || 'image/png' };
  }
  return null;
}

function pageTextsOf(artifact: DocumentArtifact): string[] | null {
  const raw = artifact.providerRaw as { metadata?: { pageTexts?: unknown } } | undefined;
  const pages = raw?.metadata?.pageTexts;
  return Array.isArray(pages) && pages.every((page) => typeof page === 'string')
    ? (pages as string[])
    : null;
}

function cellsOf(block: DocumentBlock): string[][] | undefined {
  const data = block.metadata?.data;
  if (!Array.isArray(data)) return undefined;
  return data
    .slice(0, 500)
    .map((row) =>
      Array.isArray(row) ? row.slice(0, 50).map((cell) => String(cell ?? '').slice(0, 2000)) : [],
    );
}

function storedBlock(block: DocumentBlock): StoredArtifactBlock {
  const layoutType =
    typeof block.metadata?.layoutType === 'string' ? block.metadata.layoutType : undefined;
  const cells = block.type === 'table' ? cellsOf(block) : undefined;
  return {
    id: block.id,
    type: block.type,
    ...(block.text ? { text: block.text } : {}),
    ...(typeof block.pageNumber === 'number' && block.pageNumber > 0
      ? { pageNumber: block.pageNumber }
      : {}),
    ...(block.bbox ? { bbox: block.bbox } : {}),
    ...(cells ? { cells } : {}),
    ...(layoutType ? { layoutType } : {}),
  };
}

/** The plain text every existing consumer derives from an artifact. */
export function artifactPlainText(artifact: DocumentArtifact): string {
  return artifact.blocks
    .filter((block) => block.type === 'text' || block.type === 'markdown')
    .map((block) => block.text?.trim())
    .filter((text): text is string => Boolean(text))
    .join('\n\n');
}

export function normalizeDocumentArtifact(
  artifact: DocumentArtifact,
  extractor: { id: string; version: string },
): NormalizedArtifact {
  const text = artifactPlainText(artifact);
  const pageTexts = pageTextsOf(artifact);
  const blocks: StoredArtifactBlock[] = [];
  if (pageTexts) {
    // unpdf: replace the single merged block with one text block per page.
    pageTexts.forEach((pageText, index) => {
      const trimmed = pageText.trim();
      if (trimmed)
        blocks.push({
          id: `page_${index + 1}`,
          type: 'text',
          text: trimmed,
          pageNumber: index + 1,
        });
    });
    for (const block of artifact.blocks) {
      if (block.type !== 'text' && block.type !== 'markdown') blocks.push(storedBlock(block));
    }
  } else {
    for (const block of artifact.blocks) blocks.push(storedBlock(block));
  }

  const images: PendingArtifactImage[] = [];
  for (const asset of artifact.assets ?? []) {
    if (images.length >= MAX_ARTIFACT_IMAGES) break;
    if (asset.type !== 'image' || typeof asset.data !== 'string') continue;
    const decoded = decodeDataUrl(asset.data, asset.mimeType);
    if (!decoded || decoded.bytes.byteLength === 0) continue;
    if (decoded.bytes.byteLength > MAX_ARTIFACT_IMAGE_BYTES) continue;
    if (!/^image\/(png|jpeg|webp|gif)$/.test(decoded.mime)) continue;
    const id = `img_${images.length + 1}`;
    images.push({
      id,
      bytes: decoded.bytes,
      mimeType: decoded.mime,
      ...(typeof asset.pageNumber === 'number' && asset.pageNumber > 0
        ? { pageNumber: asset.pageNumber }
        : {}),
      ...(asset.width ? { width: asset.width } : {}),
      ...(asset.height ? { height: asset.height } : {}),
      ...(asset.description ? { description: asset.description.slice(0, 500) } : {}),
    });
    blocks.push({
      id: `block_${id}`,
      type: 'image',
      imageId: id,
      ...(typeof asset.pageNumber === 'number' && asset.pageNumber > 0
        ? { pageNumber: asset.pageNumber }
        : {}),
      ...(asset.description ? { text: asset.description.slice(0, 500) } : {}),
    });
  }

  const pageCount = Math.max(
    artifact.metadata.pageCount ?? 0,
    pageTexts?.length ?? 0,
    ...blocks.map((block) => block.pageNumber ?? 0),
  );
  const paged = pageCount > 0 && blocks.some((block) => block.pageNumber !== undefined);
  const diagnostics = (artifact.diagnostics ?? [])
    .slice(0, MAX_DIAGNOSTICS)
    .map((diagnostic) => `${diagnostic.severity}: ${diagnostic.message}`.slice(0, 300));

  return {
    document: {
      version: 1,
      transform: STUDY_ARTIFACT_TRANSFORM_VERSION,
      extractorId: extractor.id,
      extractorVersion: extractor.version,
      mimeType: artifact.metadata.mimeType ?? 'application/octet-stream',
      pageCount,
      paged,
      blocks,
      diagnostics,
    },
    images,
    text,
  };
}

/** Blocks shown for one page (paged artifacts) or for the whole text (unpaged). */
export function readerBlocksForPage(
  document: StoredArtifactDocument,
  page: number | null,
  maxChars: number,
): { blocks: ReaderBlock[]; truncated: boolean } {
  const selected =
    document.paged && page !== null
      ? document.blocks.filter((block) => block.pageNumber === page)
      : document.blocks;
  const blocks: ReaderBlock[] = [];
  let used = 0;
  let truncated = false;
  for (const block of selected) {
    const textLength = (block.text?.length ?? 0) + (block.cells?.flat().join('').length ?? 0);
    if (used + textLength > maxChars) {
      truncated = true;
      break;
    }
    used += textLength;
    const tableText = block.cells?.map((row) => row.join('\t')).join('\n');
    blocks.push({
      id: block.id,
      type: block.type,
      ...(block.pageNumber !== undefined ? { pageNumber: block.pageNumber } : {}),
      ...(block.bbox ? { bbox: block.bbox } : {}),
      ...(block.imageId ? { imageId: block.imageId } : {}),
      ...(tableText
        ? { text: block.text ? `${block.text}\n${tableText}` : tableText }
        : block.text
          ? { text: block.text }
          : {}),
    });
  }
  return { blocks, truncated };
}
