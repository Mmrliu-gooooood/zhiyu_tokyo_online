/**
 * POST { submitKey, answers?, baseRevision? }: submit once. With `answers`
 * (and the draft revision they were based on) those are the final answers;
 * without, the saved draft is submitted. Grading runs on the server against
 * the paper's frozen key. A repeated or concurrent submit changes nothing and
 * returns the stored result (`alreadySubmitted: true`).
 */
import { submitPaperAttempt } from '@/lib/server/study/exams/service';
import { invalidInput, readStudyBody, studyExamsRoute, studyJson } from '@/lib/server/study/route';
import { StudyError } from '@/lib/server/study/spaces/repository';
import {
  ATTEMPT_LIMITS,
  isAttemptId,
  isRequestKey,
  type AttemptAnswers,
} from '@/lib/study/assessments/contracts';

export const runtime = 'nodejs';

type Context = { params: Promise<{ attemptId: string }> };

export function POST(req: Request, context: Context) {
  return studyExamsRoute(req, async (ownerId, db, headers) => {
    const { attemptId } = await context.params;
    if (!isAttemptId(attemptId)) throw new StudyError('STUDY_ATTEMPT_NOT_FOUND');
    const body = await readStudyBody(req, ATTEMPT_LIMITS.answersBytes);
    if (!body) return invalidInput('body', headers);
    if (!isRequestKey(body.submitKey)) return invalidInput('submitKey', headers);
    const answers = body.answers ?? null;
    if (answers !== null && (typeof answers !== 'object' || Array.isArray(answers))) {
      return invalidInput('answers', headers);
    }
    const baseRevision = body.baseRevision ?? null;
    if (answers !== null && (!Number.isInteger(baseRevision) || (baseRevision as number) < 1)) {
      return invalidInput('baseRevision', headers);
    }
    // Malformed final answers (unknown item or option, a repeat) are 400 STUDY_ANSWERS_INVALID.
    const result = await submitPaperAttempt(db, ownerId, attemptId, {
      answers: answers as AttemptAnswers | null,
      baseRevision: baseRevision as number | null,
      submitKey: body.submitKey,
    });
    return studyJson(result, 200, headers);
  });
}
