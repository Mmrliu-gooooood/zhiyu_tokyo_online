/**
 * POST { position, earned, note? } — the student's own score for an open
 * item ("I think the grading is off"). Kept apart from the graded score and
 * shown next to it; it never replaces it.
 */
import { getAttemptView } from '@/lib/server/study/exams/repository';
import { recordSelfGrade } from '@/lib/server/study/grading/service';
import {
  invalidInput,
  readStudyBody,
  studyGradingRoute,
  studyJson,
} from '@/lib/server/study/route';
import { StudyError } from '@/lib/server/study/spaces/repository';
import { isAttemptId } from '@/lib/study/assessments/contracts';
import { normalizeText } from '@/lib/study/questions/contracts';

export const runtime = 'nodejs';

const NOTE_MAX = 500;

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
    if (!Number.isInteger(body.earned) || (body.earned as number) < 0) {
      return invalidInput('earned', headers);
    }
    const note =
      body.note === undefined || body.note === null
        ? null
        : typeof body.note === 'string'
          ? normalizeText(body.note) || null
          : undefined;
    if (note === undefined || (note && note.length > NOTE_MAX))
      return invalidInput('note', headers);
    const self = await recordSelfGrade(db, ownerId, attemptId, position as number, {
      earned: body.earned as number,
      note,
    });
    return studyJson({ self, attempt: await getAttemptView(db, ownerId, attemptId) }, 200, headers);
  });
}
