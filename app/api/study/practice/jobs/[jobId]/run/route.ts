/**
 * POST { thinkingConfig? } + model-selection headers — run the next step of a
 * pending AI practice job (one batch: generation, program checks, review)
 * with the student's model. The page repeats the call while the job is
 * pending; a job that is not pending, or whose step another request holds,
 * comes back unchanged without a model call. Responds with `{ job, ran }`.
 */
import { runPracticeStep } from '@/lib/server/study/practice/service';
import { invalidInput, readStudyBody, studyPracticeRoute } from '@/lib/server/study/route';
import { StudyError } from '@/lib/server/study/spaces/repository';
import { isPracticeJobId } from '@/lib/study/practice/contracts';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Context = { params: Promise<{ jobId: string }> };

export function POST(req: Request, context: Context) {
  return studyPracticeRoute(req, async (ownerId, db, headers) => {
    const { jobId } = await context.params;
    if (!isPracticeJobId(jobId)) throw new StudyError('STUDY_PRACTICE_JOB_NOT_FOUND');
    const body = await readStudyBody(req);
    if (!body) return invalidInput('body', headers);
    return runPracticeStep(req, db, ownerId, { jobId, body }, headers);
  });
}
