/**
 * POST { position } — ask for another grading of an open item. The earlier
 * grading is kept and shown; the new one waits until the report page runs
 * it. Only after the latest grading finished, and a few times per item.
 */
import { getAttemptView } from '@/lib/server/study/exams/repository';
import { requestReview } from '@/lib/server/study/grading/service';
import {
  invalidInput,
  readStudyBody,
  studyGradingRoute,
  studyJson,
} from '@/lib/server/study/route';
import { StudyError } from '@/lib/server/study/spaces/repository';
import { isAttemptId } from '@/lib/study/assessments/contracts';

export const runtime = 'nodejs';

type Context = { params: Promise<{ attemptId: string }> };

export function POST(req: Request, context: Context) {
  return studyGradingRoute(req, async (ownerId, db, headers) => {
    const { attemptId } = await context.params;
    if (!isAttemptId(attemptId)) throw new StudyError('STUDY_ATTEMPT_NOT_FOUND');
    const body = await readStudyBody(req);
    if (!body) return invalidInput('body', headers);
    const position = body.position;
    if (!Number.isInteger(position) || (position as number) < 1 || (position as number) > 100) {
      return invalidInput('position', headers);
    }
    const review = await requestReview(db, ownerId, attemptId, position as number);
    return studyJson(
      { review, attempt: await getAttemptView(db, ownerId, attemptId) },
      200,
      headers,
    );
  });
}
