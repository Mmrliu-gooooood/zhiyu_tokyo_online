/**
 * POST { position?, thinkingConfig? } + model-selection headers — grade the
 * next waiting open item of a submitted attempt, or the named item (also to
 * retry one that failed). One item per request; the report page repeats the
 * call until nothing is waiting. With nothing to grade it changes nothing and
 * calls no model. Responds with `{ graded, waiting, attempt }`.
 */
import { gradeNextItem } from '@/lib/server/study/grading/service';
import { invalidInput, readStudyBody, studyGradingRoute } from '@/lib/server/study/route';
import { StudyError } from '@/lib/server/study/spaces/repository';
import { isAttemptId } from '@/lib/study/assessments/contracts';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Context = { params: Promise<{ attemptId: string }> };

export function POST(req: Request, context: Context) {
  return studyGradingRoute(req, async (ownerId, db, headers) => {
    const { attemptId } = await context.params;
    if (!isAttemptId(attemptId)) throw new StudyError('STUDY_ATTEMPT_NOT_FOUND');
    const body = await readStudyBody(req);
    if (!body) return invalidInput('body', headers);
    const position = body.position ?? null;
    if (
      position !== null &&
      (!Number.isInteger(position) || (position as number) < 1 || (position as number) > 100)
    ) {
      return invalidInput('position', headers);
    }
    return gradeNextItem(
      req,
      db,
      ownerId,
      { attemptId, position: position as number | null, body },
      headers,
    );
  });
}
