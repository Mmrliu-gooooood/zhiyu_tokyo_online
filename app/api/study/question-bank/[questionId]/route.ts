/**
 * GET: one bank question (current version). PATCH { question, verified,
 * stageId, baseVersion }: save an edit as a new version (409 with the stored
 * question when the editor was stale). DELETE: remove it — papers that froze
 * it keep their copy.
 */
import { deleteQuestion, getQuestion } from '@/lib/server/study/questions/repository';
import { editQuestion } from '@/lib/server/study/questions/service';
import { invalidInput, readStudyBody, studyExamsRoute, studyJson } from '@/lib/server/study/route';
import { StudyError } from '@/lib/server/study/spaces/repository';
import { QUESTION_LIMITS, isQuestionId } from '@/lib/study/questions/contracts';
import { isContentId } from '@/lib/study/spaces/contracts';

export const runtime = 'nodejs';

type Context = { params: Promise<{ questionId: string }> };

async function questionIdOf(context: Context): Promise<string> {
  const { questionId } = await context.params;
  if (!isQuestionId(questionId)) throw new StudyError('STUDY_QUESTION_NOT_FOUND');
  return questionId;
}

export function GET(req: Request, context: Context) {
  return studyExamsRoute(req, async (ownerId, db, headers) => {
    const question = await getQuestion(db, ownerId, await questionIdOf(context));
    return studyJson({ question }, 200, headers);
  });
}

export function PATCH(req: Request, context: Context) {
  return studyExamsRoute(req, async (ownerId, db, headers) => {
    const questionId = await questionIdOf(context);
    const body = await readStudyBody(req, QUESTION_LIMITS.editBytes);
    if (!body) return invalidInput('body', headers);
    if (typeof body.verified !== 'boolean') return invalidInput('verified', headers);
    const stageId = body.stageId ?? null;
    if (stageId !== null && !isContentId(stageId)) return invalidInput('stageId', headers);
    if (!Number.isInteger(body.baseVersion) || (body.baseVersion as number) < 1) {
      return invalidInput('baseVersion', headers);
    }
    const question = await editQuestion(db, ownerId, questionId, {
      question: body.question,
      verified: body.verified,
      stageId: stageId as string | null,
      baseVersion: body.baseVersion as number,
    });
    return studyJson({ question }, 200, headers);
  });
}

export function DELETE(req: Request, context: Context) {
  return studyExamsRoute(req, async (ownerId, db, headers) => {
    await deleteQuestion(db, ownerId, await questionIdOf(context));
    return studyJson({ deleted: true }, 200, headers);
  });
}
