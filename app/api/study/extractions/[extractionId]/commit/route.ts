/**
 * POST { candidateIds, stageId? } — add these candidates to the question bank
 * as `material_extracted` questions (learning plan B08). Open questions,
 * discarded or incomplete candidates are reported `invalid`; committed ones
 * `skipped`; a question the bank already has is a `duplicate`. Needs the
 * material to be still in the library and linked to the space.
 */
import { commitCandidates } from '@/lib/server/study/extraction/service';
import {
  invalidInput,
  readStudyBody,
  studyExtractionRoute,
  studyJson,
} from '@/lib/server/study/route';
import { StudyError } from '@/lib/server/study/spaces/repository';
import { EXTRACTION_LIMITS, isCandidateId, isExtractionId } from '@/lib/study/extraction/contracts';
import { isContentId } from '@/lib/study/spaces/contracts';

export const runtime = 'nodejs';

type Context = { params: Promise<{ extractionId: string }> };

export function POST(req: Request, context: Context) {
  return studyExtractionRoute(req, async (ownerId, db, headers) => {
    const { extractionId } = await context.params;
    if (!isExtractionId(extractionId)) throw new StudyError('STUDY_EXTRACTION_NOT_FOUND');
    const body = await readStudyBody(req, 64_000);
    if (!body) return invalidInput('body', headers);
    const ids = body.candidateIds;
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.length > EXTRACTION_LIMITS.candidatesPerExtraction ||
      !ids.every(isCandidateId)
    ) {
      return invalidInput('candidateIds', headers);
    }
    const stageId = body.stageId ?? null;
    if (stageId !== null && !isContentId(stageId)) return invalidInput('stageId', headers);
    const result = await commitCandidates(db, ownerId, extractionId, {
      candidateIds: ids,
      stageId: stageId as string | null,
    });
    return studyJson(result, 200, headers);
  });
}
