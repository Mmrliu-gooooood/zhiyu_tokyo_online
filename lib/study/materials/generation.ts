'use client';

/**
 * Course generation from study-library materials (learning plan B02): the
 * versions' stored parse text is fetched and bundled exactly like freshly
 * extracted uploads, then handed to the existing generation session as
 * `pdfText`. Both the foreground and the background generation paths skip
 * document extraction when that text is present, so nothing is re-parsed and
 * no file bytes are copied.
 */
import { buildDocumentBundle, type ParsedDocumentPart } from '@/lib/document/bundle';
import { materialsApi } from '@/lib/study/materials/client';

export interface StudyMaterialSelection {
  materialId: string;
  versionId: string;
  title: string;
}

export async function studyMaterialsGenerationText(
  selection: readonly StudyMaterialSelection[],
): Promise<{ text: string; truncated: boolean }> {
  const parts: ParsedDocumentPart[] = [];
  for (const [index, item] of selection.entries()) {
    const body = await materialsApi.text(item.materialId, item.versionId);
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
      images: [],
    });
  }
  const bundle = buildDocumentBundle(parts);
  return { text: bundle.text, truncated: bundle.totalRawTextLength > bundle.textContentBudget };
}
