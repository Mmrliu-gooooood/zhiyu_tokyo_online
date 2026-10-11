/**
 * PUT { answers, baseRevision }: save the draft. A stale revision (another
 * tab or device saved meanwhile) gets 409 with the stored answers and
 * revision instead of silently overwriting them; a submitted attempt is 409
 * STUDY_ATTEMPT_SUBMITTED.
 */
import { saveAttemptDraft } from '@/lib/server/study/exams/service';
import { invalidInput, readStudyBody, studyExamsRoute, studyJson } from '@/lib/server/study/route';
import { StudyError } from '@/lib/server/study/spaces/repository';
import { ATTEMPT_LIMITS, isAttemptId } from '@/lib/study/assessments/contracts';

export const runtime = 'nodejs';

type Context = { params: Promise<{ attemptId: string }> };

export function PUT(req: Request, context: Context) {
  return studyExamsRoute(req, async (ownerId, db, headers) => {
    const { attemptId } = await context.params;
    if (!isAttemptId(attemptId)) throw new StudyError('STUDY_ATTEMPT_NOT_FOUND');
    const body = await readStudyBody(req, ATTEMPT_LIMITS.answersBytes);
    if (!body) return invalidInput('body', headers);
    if (!Number.isInteger(body.baseRevision) || (body.baseRevision as number) < 1) {
      return invalidInput('baseRevision', headers);
    }
    const saved = await saveAttemptDraft(
      db,
      ownerId,
      attemptId,
      body.answers,
      body.baseRevision as number,
    );
    if (!saved) return invalidInput('answers', headers);
    return studyJson(saved, 200, headers);
  });
}
