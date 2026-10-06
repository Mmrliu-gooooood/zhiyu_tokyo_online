/** DELETE — remove one saved answer and its citations (learning plan B03). */
import { isStudyId } from '@/lib/study/spaces/contracts';
import { studyJson, studyQaRoute } from '@/lib/server/study/route';
import { StudyError } from '@/lib/server/study/spaces/repository';
import { deleteStudyAnswer } from '@/lib/server/study/knowledge/repository';

export const runtime = 'nodejs';

type Context = { params: Promise<{ spaceId: string; answerId: string }> };

export function DELETE(req: Request, context: Context) {
  return studyQaRoute(req, async (ownerId, db, headers) => {
    const { spaceId, answerId } = await context.params;
    if (!isStudyId(spaceId) || !isStudyId(answerId)) throw new StudyError('STUDY_SPACE_NOT_FOUND');
    const deleted = await db.withTransaction((tx) =>
      deleteStudyAnswer(tx, ownerId, spaceId, answerId),
    );
    if (!deleted) throw new StudyError('STUDY_SPACE_NOT_FOUND');
    return studyJson({ deleted: true }, 200, headers);
  });
}
