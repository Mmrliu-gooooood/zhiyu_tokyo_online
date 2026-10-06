/**
 * Stored B02 parse artifact → retrieval chunks (learning plan B03), through the
 * repository's document chunker (lib/rag). Every chunk keeps its locator in
 * the parsed material: version, page (file page order, never a guessed printed
 * page) and block id, so a citation can open the exact place in the reader.
 *
 * Table cells become tab-separated rows; image blocks contribute their
 * description; pages of a paged artifact without any text-bearing block (a
 * scan read by a parser without OCR) are reported as unparsed, not indexed.
 */
import type { DocumentArtifact, DocumentBlock } from '@/lib/document/types';
import { chunkDocumentArtifact } from '@/lib/rag/chunking';
import type { KnowledgeChunk } from '@/lib/rag/types';
import type { StoredArtifactDocument } from '@/lib/server/study/materials/artifact';

import { STUDY_CHUNK_POLICY } from './config';

export interface StudyChunkSource {
  ownerId: string;
  materialId: string;
  versionId: string;
  artifactId: string;
  title: string;
  sha256: string;
}

export interface StudyChunkPlan {
  chunks: KnowledgeChunk[];
  unparsedPages: number[];
  textChars: number;
}

function blockText(block: StoredArtifactDocument['blocks'][number]): string {
  const rows = block.cells?.map((row) => row.join('\t')).join('\n');
  return [block.text?.trim(), rows?.trim()].filter(Boolean).join('\n');
}

export function planStudyChunks(
  document: StoredArtifactDocument,
  source: StudyChunkSource,
): StudyChunkPlan {
  const blocks: DocumentBlock[] = [];
  const pagesWithText = new Set<number>();
  for (const block of document.blocks) {
    const text = blockText(block);
    if (!text) continue;
    if (block.pageNumber) pagesWithText.add(block.pageNumber);
    blocks.push({
      id: block.id,
      type: block.type === 'image' ? 'image' : block.type,
      text,
      ...(block.pageNumber ? { pageNumber: block.pageNumber } : {}),
    } as DocumentBlock);
  }
  const artifact = {
    id: source.artifactId,
    source: { kind: 'upload' },
    metadata: { mimeType: document.mimeType, pageCount: document.pageCount },
    blocks,
  } as unknown as DocumentArtifact;
  const chunks = chunkDocumentArtifact(
    artifact,
    {
      id: source.materialId,
      resourceVersionId: `${source.versionId}:${source.artifactId}`,
      workspaceId: source.ownerId,
      modality: 'document',
      title: source.title,
      sourceRef: `study:${source.versionId}`,
      contentHash: source.sha256,
      status: 'ready',
      lineage: {
        sourceHash: source.sha256,
        extractor: { id: document.extractorId, version: document.extractorVersion },
        transforms: [{ id: document.transform, version: '1' }],
        chunkPolicy: { id: STUDY_CHUNK_POLICY.id, version: STUDY_CHUNK_POLICY.version },
      },
      metadata: {},
    },
    { maxChars: STUDY_CHUNK_POLICY.maxChars },
  );
  const unparsedPages: number[] = [];
  if (document.paged) {
    for (let page = 1; page <= document.pageCount; page += 1) {
      if (!pagesWithText.has(page)) unparsedPages.push(page);
    }
  }
  return {
    chunks: [...chunks],
    unparsedPages,
    textChars: chunks.reduce((sum, chunk) => sum + chunk.text.length, 0),
  };
}
