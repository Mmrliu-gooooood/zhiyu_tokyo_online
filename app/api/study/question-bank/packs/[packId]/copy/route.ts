/**
 * POST { spaceId, questionIds }: copy official questions into the subject's
 * own bank, where they can be edited (the pack stays unchanged). Copying the
 * same question again adds nothing.
 */
import { copyPackQuestions } from '@/lib/server/study/questions/service';
import { invalidInput, readStudyBody, studyExamsRoute, studyJson } from '@/lib/server/study/route';
import { isContentId } from '@/lib/study/spaces/contracts';

export const runtime = 'nodejs';

type Context = { params: Promise<{ packId: string }> };

export function POST(req: Request, context: Context) {
  return studyExamsRoute(req, async (ownerId, db, headers) => {
    const { packId } = await context.params;
    const body = await readStudyBody(req);
    if (!body) return invalidInput('body', headers);
    if (!isContentId(body.spaceId)) return invalidInput('spaceId', headers);
    const ids = body.questionIds;
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.length > 200 ||
      !ids.every((id) => isContentId(id, 80))
    ) {
      return invalidInput('questionIds', headers);
    }
    const result = await copyPackQuestions(db, ownerId, {
      spaceId: body.spaceId,
      packId,
      questionIds: ids as string[],
    });
    return studyJson(result, 200, headers);
  });
}
