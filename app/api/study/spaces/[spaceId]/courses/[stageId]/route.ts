/** DELETE: remove a course from the space. The course and its progress stay. */
import { isContentId, isStudyId } from '@/lib/study/spaces/contracts';
import { studyJson, studyRoute } from '@/lib/server/study/route';
import { StudyError, unlinkStudySpaceCourse } from '@/lib/server/study/spaces/repository';

export const runtime = 'nodejs';

type Context = { params: Promise<{ spaceId: string; stageId: string }> };

export function DELETE(req: Request, context: Context) {
  return studyRoute(req, async (ownerId, db, headers) => {
    const { spaceId, stageId } = await context.params;
    if (!isStudyId(spaceId)) throw new StudyError('STUDY_SPACE_NOT_FOUND');
    if (!isContentId(stageId)) throw new StudyError('STUDY_COURSE_NOT_FOUND');
    await unlinkStudySpaceCourse(db, ownerId, spaceId, stageId);
    return studyJson({ removed: true }, 200, headers);
  });
}
