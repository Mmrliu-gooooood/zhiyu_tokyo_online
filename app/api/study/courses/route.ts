/** GET: the owner's live courses that can be linked into a space. */
import { studyJson, studyRoute } from '@/lib/server/study/route';
import { listLinkableCourses } from '@/lib/server/study/spaces/repository';

export const runtime = 'nodejs';

export function GET(req: Request) {
  return studyRoute(req, async (ownerId, db, headers) =>
    studyJson({ courses: await listLinkableCourses(db, ownerId) }, 200, headers),
  );
}
