/**
 * POST { candidateIds, thinkingConfig? } + model-selection headers — ask the
 * student's selected model to tidy up to a few draft candidates and suggest
 * answers (learning plan B08). Suggestions are stored next to the candidates
 * and change nothing until adopted. One budgeted request (≤ 2 model calls).
 */
import { assistCandidates } from '@/lib/server/study/extraction/assist';
import { invalidInput, readStudyBody, studyExtractionRoute } from '@/lib/server/study/route';
import { StudyError } from '@/lib/server/study/spaces/repository';
import { EXTRACTION_LIMITS, isCandidateId, isExtractionId } from '@/lib/study/extraction/contracts';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Context = { params: Promise<{ extractionId: string }> };

export function POST(req: Request, context: Context) {
  return studyExtractionRoute(req, async (ownerId, db, headers) => {
    const { extractionId } = await context.params;
    if (!isExtractionId(extractionId)) throw new StudyError('STUDY_EXTRACTION_NOT_FOUND');
    const body = await readStudyBody(req);
    if (!body) return invalidInput('body', headers);
    const ids = body.candidateIds;
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.length > EXTRACTION_LIMITS.assistBatch ||
      !ids.every(isCandidateId)
    ) {
      return invalidInput('candidateIds', headers);
    }
    return assistCandidates(req, db, ownerId, { extractionId, candidateIds: ids, body }, headers);
  });
}
