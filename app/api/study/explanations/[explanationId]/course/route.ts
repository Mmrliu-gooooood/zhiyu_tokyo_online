/**
 * POST `{ jobId }` or `{ stageId }` — course generation reports back on a
 * course explanation: first its job, then its course, which joins the
 * subject once. A second course is refused (409) while the first is still
 * in the subject. Responds with `{ explanation, created }`.
 */
import { attachCourse } from '@/lib/server/study/explanations/service';
import {
  invalidInput,
  readStudyBody,
  studyExplanationsRoute,
  studyJson,
} from '@/lib/server/study/route';
import { StudyError } from '@/lib/server/study/spaces/repository';
import { isExplanationId } from '@/lib/study/explanations/contracts';

export const runtime = 'nodejs';

type Context = { params: Promise<{ explanationId: string }> };

export function POST(req: Request, context: Context) {
  return studyExplanationsRoute(req, async (ownerId, db, headers) => {
    const { explanationId } = await context.params;
    if (!isExplanationId(explanationId)) throw new StudyError('STUDY_EXPLANATION_NOT_FOUND');
    const body = await readStudyBody(req);
    if (!body) return invalidInput('body', headers);
    const jobId = typeof body.jobId === 'string' ? body.jobId : undefined;
    const stageId = typeof body.stageId === 'string' ? body.stageId : undefined;
    if ((jobId === undefined) === (stageId === undefined)) return invalidInput('body', headers);
    const result = await attachCourse(db, ownerId, explanationId, { jobId, stageId });
    return studyJson(result, 200, headers);
  });
}
