/**
 * POST { thinkingConfig? } + model-selection headers — write a pending
 * explanation with the student's model (the form's call cap at most).
 * One that is not pending, or that another request is running, comes back
 * unchanged without a model call. Leaving the page does not stop a run.
 * Responds with `{ explanation, ran }`.
 */
import { runExplanation } from '@/lib/server/study/explanations/service';
import { invalidInput, readStudyBody, studyExplanationsRoute } from '@/lib/server/study/route';
import { StudyError } from '@/lib/server/study/spaces/repository';
import { isExplanationId } from '@/lib/study/explanations/contracts';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Context = { params: Promise<{ explanationId: string }> };

export function POST(req: Request, context: Context) {
  return studyExplanationsRoute(req, async (ownerId, db, headers) => {
    const { explanationId } = await context.params;
    if (!isExplanationId(explanationId)) throw new StudyError('STUDY_EXPLANATION_NOT_FOUND');
    const body = await readStudyBody(req);
    if (!body) return invalidInput('body', headers);
    return runExplanation(req, db, ownerId, { id: explanationId, body }, headers);
  });
}
