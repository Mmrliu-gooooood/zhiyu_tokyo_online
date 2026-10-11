/**
 * GET: an attempt. While open: the items without keys plus the saved draft.
 * Once submitted: the frozen answers, the server grading and, per item, the
 * key and explanation.
 */
import { getAttemptView } from '@/lib/server/study/exams/repository';
import { studyExamsRoute, studyJson } from '@/lib/server/study/route';
import { StudyError } from '@/lib/server/study/spaces/repository';
import { isAttemptId } from '@/lib/study/assessments/contracts';

export const runtime = 'nodejs';

type Context = { params: Promise<{ attemptId: string }> };

export function GET(req: Request, context: Context) {
  return studyExamsRoute(req, async (ownerId, db, headers) => {
    const { attemptId } = await context.params;
    if (!isAttemptId(attemptId)) throw new StudyError('STUDY_ATTEMPT_NOT_FOUND');
    return studyJson({ attempt: await getAttemptView(db, ownerId, attemptId) }, 200, headers);
  });
}
