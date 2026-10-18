/**
 * POST { position, level: 'hint' | 'solution' } — show a practice item's hint
 * or solution while the attempt is open (learning plan B11). The server
 * records it with the attempt, so an answer given after seeing help never
 * counts as independent. Only practice papers offer this. Responds with the
 * updated attempt (its `assistance` carries the text).
 */
import { getAttemptView, recordAssistance } from '@/lib/server/study/exams/repository';
import {
  invalidInput,
  readStudyBody,
  studyJson,
  studyPracticeRoute,
} from '@/lib/server/study/route';
import { StudyError } from '@/lib/server/study/spaces/repository';
import { isAttemptId } from '@/lib/study/assessments/contracts';

export const runtime = 'nodejs';

type Context = { params: Promise<{ attemptId: string }> };

export function POST(req: Request, context: Context) {
  return studyPracticeRoute(req, async (ownerId, db, headers) => {
    const { attemptId } = await context.params;
    if (!isAttemptId(attemptId)) throw new StudyError('STUDY_ATTEMPT_NOT_FOUND');
    const body = await readStudyBody(req);
    if (!body) return invalidInput('body', headers);
    const position = body.position;
    if (!Number.isInteger(position) || (position as number) < 1 || (position as number) > 100) {
      return invalidInput('position', headers);
    }
    if (body.level !== 'hint' && body.level !== 'solution') return invalidInput('level', headers);
    await recordAssistance(db, ownerId, attemptId, position as number, body.level);
    return studyJson({ attempt: await getAttemptView(db, ownerId, attemptId) }, 200, headers);
  });
}
