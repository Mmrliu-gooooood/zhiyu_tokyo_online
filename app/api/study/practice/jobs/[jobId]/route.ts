/** GET — one AI practice job: its plan, what it wrote and rejected, calls used. */
import { getPracticeJobView } from '@/lib/server/study/practice/service';
import { studyJson, studyPracticeRoute } from '@/lib/server/study/route';
import { StudyError } from '@/lib/server/study/spaces/repository';
import { isPracticeJobId } from '@/lib/study/practice/contracts';

export const runtime = 'nodejs';

type Context = { params: Promise<{ jobId: string }> };

export function GET(req: Request, context: Context) {
  return studyPracticeRoute(req, async (ownerId, db, headers) => {
    const { jobId } = await context.params;
    if (!isPracticeJobId(jobId)) throw new StudyError('STUDY_PRACTICE_JOB_NOT_FOUND');
    return studyJson({ job: await getPracticeJobView(db, ownerId, jobId) }, 200, headers);
  });
}
