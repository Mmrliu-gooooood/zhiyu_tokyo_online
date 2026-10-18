/**
 * POST — cancel an unpublished AI practice job. A step still running stores
 * nothing; questions already written stay in the bank (unverified).
 */
import { cancelPracticeJob } from '@/lib/server/study/practice/service';
import { studyJson, studyPracticeRoute } from '@/lib/server/study/route';
import { StudyError } from '@/lib/server/study/spaces/repository';
import { isPracticeJobId } from '@/lib/study/practice/contracts';

export const runtime = 'nodejs';

type Context = { params: Promise<{ jobId: string }> };

export function POST(req: Request, context: Context) {
  return studyPracticeRoute(req, async (ownerId, db, headers) => {
    const { jobId } = await context.params;
    if (!isPracticeJobId(jobId)) throw new StudyError('STUDY_PRACTICE_JOB_NOT_FOUND');
    return studyJson({ job: await cancelPracticeJob(db, ownerId, jobId) }, 200, headers);
  });
}
