'use client';

/**
 * Course generation from study-library materials (learning plan B02): the
 * versions' stored parse output is fetched and bundled exactly like freshly
 * extracted uploads — text and images — then handed to the existing
 * generation session (`pdfText`, and the images through the same browser
 * image store a direct upload uses). Both the foreground and the background
 * generation paths skip document extraction when that text is present, so
 * nothing is re-parsed.
 */
import {
  buildDocumentBundle,
  sortDocumentImagesForVision,
  type ParsedDocumentImage,
  type ParsedDocumentPart,
} from '@/lib/document/bundle';
import { materialsApi } from '@/lib/study/materials/client';

export interface StudyMaterialSelection {
  materialId: string;
  versionId: string;
  title: string;
}

/**
 * At most this many library images go into one generation, chosen in the same
 * priority order the bundle uses for vision input (each document first, then
 * by page and size). It bounds browser storage and, on the background path,
 * the per-image asset uploads.
 */
export const MAX_STUDY_GENERATION_IMAGES = 60;

export type StudyGenerationImage = ParsedDocumentImage & { visionPriority: number };

export interface StudyMaterialsGenerationInput {
  text: string;
  truncated: boolean;
  /** Bundle images with `src` as a data URL, in bundle order. */
  images: StudyGenerationImage[];
  /** Every image the selected parses extracted (before the cap and load failures). */
  totalImageCount: number;
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}

async function loadImageDataUrl(url: string, signal?: AbortSignal): Promise<string | null> {
  const response = await fetch(url, { credentials: 'include', signal });
  if (!response.ok) return null;
  const blob = await response.blob();
  if (!blob.size || !blob.type.startsWith('image/')) return null;
  return blobToDataUrl(blob);
}

export async function studyMaterialsGenerationInput(
  selection: readonly StudyMaterialSelection[],
  options: { signal?: AbortSignal; maxImages?: number } = {},
): Promise<StudyMaterialsGenerationInput> {
  const { signal, maxImages = MAX_STUDY_GENERATION_IMAGES } = options;
  const parts: ParsedDocumentPart[] = [];
  const versions = new Map<
    string,
    { materialId: string; versionId: string; artifactId?: string }
  >();
  for (const [index, item] of selection.entries()) {
    const body = await materialsApi.text(item.materialId, item.versionId, signal);
    versions.set(item.versionId, {
      materialId: item.materialId,
      versionId: item.versionId,
      // Pin the image reads to the artifact this text came from.
      artifactId: body.artifactId ?? undefined,
    });
    parts.push({
      source: {
        id: item.versionId,
        name: body.name || item.title,
        size: body.text.length,
        order: index + 1,
      },
      text: body.text,
      rawTextLength: body.text.length,
      pageCount: body.pageCount || undefined,
      images: body.images.map((image) => ({
        id: image.id,
        src: '',
        pageNumber: image.pageNumber ?? 1,
        description: image.description,
        width: image.width,
        height: image.height,
      })),
    });
  }
  const bundle = buildDocumentBundle(parts);
  const chosen = new Set(
    sortDocumentImagesForVision(bundle.images)
      .slice(0, Math.max(0, maxImages))
      .map((image) => image.id),
  );
  const images: StudyGenerationImage[] = [];
  for (const image of bundle.images) {
    if (!chosen.has(image.id)) continue;
    const version = versions.get(image.sourceDocumentId ?? '');
    if (!version || !image.originalId) continue;
    // Images enrich the course; one that cannot be read is left out, not fatal.
    const src = await loadImageDataUrl(
      materialsApi.imageUrl(
        version.materialId,
        version.versionId,
        image.originalId,
        version.artifactId,
      ),
      signal,
    ).catch((error) => {
      if (signal?.aborted) throw error;
      return null;
    });
    if (src) images.push({ ...image, src });
  }
  return {
    text: bundle.text,
    truncated: bundle.totalRawTextLength > bundle.textContentBudget,
    images,
    totalImageCount: bundle.totalImageCount,
  };
}
