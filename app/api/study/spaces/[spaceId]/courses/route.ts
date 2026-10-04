/** POST: link one of the owner's courses into the space (idempotent). */
import { isContentId, isStudyId } from '@/lib/study/spaces/contracts';
import { invalidInput, readStudyBody, studyJson, studyRoute } from '@/lib/server/study/route';
import { StudyError, linkStudySpaceCourse } from '@/lib/server/study/spaces/repository';

export const runtime = 'nodejs';

type Context = { params: Promise<{ spaceId: string }> };

export function POST(req: Request, context: Context) {
  return studyRoute(req, async (ownerId, db, headers) => {
    const { spaceId } = await context.params;
    if (!isStudyId(spaceId)) throw new StudyError('STUDY_SPACE_NOT_FOUND');
    const body = await readStudyBody(req);
    const stageId = body?.stageId;
    if (!isContentId(stageId)) return invalidInput('stageId', headers);
    const via = body?.via ?? 'link';
    if (via !== 'link' && via !== 'generation') return invalidInput('via', headers);
    const result = await linkStudySpaceCourse(db, ownerId, spaceId, stageId, via);
    return studyJson(result, result.created ? 201 : 200, headers);
  });
}
