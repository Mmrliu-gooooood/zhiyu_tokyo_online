/**
 * GET — an extraction with its candidates (learning plan B08).
 * DELETE — remove the extraction and its candidates; questions already
 * committed to the bank stay.
 */
import { deleteExtraction } from '@/lib/server/study/extraction/repository';
import { extractionDetail } from '@/lib/server/study/extraction/service';
import { studyExtractionRoute, studyJson } from '@/lib/server/study/route';
import { StudyError } from '@/lib/server/study/spaces/repository';
import { isExtractionId } from '@/lib/study/extraction/contracts';

export const runtime = 'nodejs';

type Context = { params: Promise<{ extractionId: string }> };

async function extractionIdOf(context: Context): Promise<string> {
  const { extractionId } = await context.params;
  if (!isExtractionId(extractionId)) throw new StudyError('STUDY_EXTRACTION_NOT_FOUND');
  return extractionId;
}

export function GET(req: Request, context: Context) {
  return studyExtractionRoute(req, async (ownerId, db, headers) => {
    const detail = await extractionDetail(db, ownerId, await extractionIdOf(context));
    return studyJson(detail, 200, headers);
  });
}

export function DELETE(req: Request, context: Context) {
  return studyExtractionRoute(req, async (ownerId, db, headers) => {
    await deleteExtraction(db, ownerId, await extractionIdOf(context));
    return studyJson({ deleted: true }, 200, headers);
  });
}
