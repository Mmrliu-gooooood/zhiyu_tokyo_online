/**
 * GET: the owner's server-side position in a course (null before the first
 * write). PUT: record a new position, based on the revision the client last
 * saw; a stale revision answers 409 with the current progress.
 */
import { isContentId, parseProgressWrite } from '@/lib/study/spaces/contracts';
import { invalidInput, readStudyBody, studyJson, studyRoute } from '@/lib/server/study/route';
import {
  StudyError,
  getCourseProgress,
  writeCourseProgress,
} from '@/lib/server/study/spaces/repository';

export const runtime = 'nodejs';

type Context = { params: Promise<{ stageId: string }> };

export function GET(req: Request, context: Context) {
  return studyRoute(req, async (ownerId, db, headers) => {
    const { stageId } = await context.params;
    if (!isContentId(stageId)) throw new StudyError('STUDY_COURSE_NOT_FOUND');
    return studyJson({ progress: await getCourseProgress(db, ownerId, stageId) }, 200, headers);
  });
}

export function PUT(req: Request, context: Context) {
  return studyRoute(req, async (ownerId, db, headers) => {
    const { stageId } = await context.params;
    if (!isContentId(stageId)) throw new StudyError('STUDY_COURSE_NOT_FOUND');
    const parsed = parseProgressWrite(await readStudyBody(req));
    if (!parsed.ok) return invalidInput(parsed.field, headers);
    const progress = await writeCourseProgress(db, ownerId, stageId, parsed.value);
    return studyJson({ progress }, 200, headers);
  });
}
