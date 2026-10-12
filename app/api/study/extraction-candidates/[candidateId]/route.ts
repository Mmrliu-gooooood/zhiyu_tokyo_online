/**
 * PATCH { revision, content?, checked?, status? } — save the student's
 * correction of one candidate (learning plan B08). `status` is `draft` or
 * `discarded`. A stale revision answers 409 with the stored candidate.
 */
import { updateCandidate } from '@/lib/server/study/extraction/service';
import {
  invalidInput,
  readStudyBody,
  studyExtractionRoute,
  studyJson,
} from '@/lib/server/study/route';
import { StudyError } from '@/lib/server/study/spaces/repository';
import { isCandidateId } from '@/lib/study/extraction/contracts';
import { QUESTION_LIMITS } from '@/lib/study/questions/contracts';

export const runtime = 'nodejs';

type Context = { params: Promise<{ candidateId: string }> };

export function PATCH(req: Request, context: Context) {
  return studyExtractionRoute(req, async (ownerId, db, headers) => {
    const { candidateId } = await context.params;
    if (!isCandidateId(candidateId)) throw new StudyError('STUDY_CANDIDATE_NOT_FOUND');
    const body = await readStudyBody(req, QUESTION_LIMITS.editBytes);
    if (!body) return invalidInput('body', headers);
    if (!Number.isInteger(body.revision)) return invalidInput('revision', headers);
    if (body.checked !== undefined && typeof body.checked !== 'boolean') {
      return invalidInput('checked', headers);
    }
    if (body.status !== undefined && body.status !== 'draft' && body.status !== 'discarded') {
      return invalidInput('status', headers);
    }
    const candidate = await updateCandidate(db, ownerId, candidateId, {
      revision: body.revision as number,
      ...(body.content !== undefined ? { content: body.content } : {}),
      ...(body.checked !== undefined ? { checked: body.checked as boolean } : {}),
      ...(body.status !== undefined ? { status: body.status as 'draft' | 'discarded' } : {}),
    });
    return studyJson({ candidate }, 200, headers);
  });
}
