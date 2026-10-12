/**
 * POST { action, revision, atLine? } on one candidate (learning plan B08):
 * - `restore`: back to what the extractor produced;
 * - `adopt`: take the model's suggestion (answer recorded as `model`);
 * - `split`: two candidates, the second starting at source line `atLine`;
 * - `merge`: join with the next candidate.
 * Split and merge answer with the whole extraction (positions change).
 */
import {
  adoptSuggestion,
  mergeWithNext,
  restoreCandidate,
  splitCandidate,
} from '@/lib/server/study/extraction/service';
import {
  invalidInput,
  readStudyBody,
  studyExtractionRoute,
  studyJson,
} from '@/lib/server/study/route';
import { StudyError } from '@/lib/server/study/spaces/repository';
import { isCandidateId } from '@/lib/study/extraction/contracts';

export const runtime = 'nodejs';

type Context = { params: Promise<{ candidateId: string }> };

export function POST(req: Request, context: Context) {
  return studyExtractionRoute(req, async (ownerId, db, headers) => {
    const { candidateId } = await context.params;
    if (!isCandidateId(candidateId)) throw new StudyError('STUDY_CANDIDATE_NOT_FOUND');
    const body = await readStudyBody(req);
    if (!body) return invalidInput('body', headers);
    if (!Number.isInteger(body.revision)) return invalidInput('revision', headers);
    const revision = body.revision as number;
    switch (body.action) {
      case 'restore':
        return studyJson(
          { candidate: await restoreCandidate(db, ownerId, candidateId, revision) },
          200,
          headers,
        );
      case 'adopt':
        return studyJson(
          { candidate: await adoptSuggestion(db, ownerId, candidateId, revision) },
          200,
          headers,
        );
      case 'split':
        if (!Number.isInteger(body.atLine)) return invalidInput('atLine', headers);
        return studyJson(
          await splitCandidate(db, ownerId, candidateId, {
            revision,
            atLine: body.atLine as number,
          }),
          200,
          headers,
        );
      case 'merge':
        return studyJson(await mergeWithNext(db, ownerId, candidateId, revision), 200, headers);
      default:
        return invalidInput('action', headers);
    }
  });
}
