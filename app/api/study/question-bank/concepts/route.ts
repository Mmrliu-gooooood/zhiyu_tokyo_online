/** GET ?spaceId: the subject's knowledge points with how many questions use each. */
import { listConcepts, requireQuestionSpace } from '@/lib/server/study/questions/repository';
import { invalidInput, studyExamsRoute, studyJson } from '@/lib/server/study/route';
import { isContentId } from '@/lib/study/spaces/contracts';

export const runtime = 'nodejs';

export function GET(req: Request) {
  return studyExamsRoute(req, async (ownerId, db, headers) => {
    const spaceId = new URL(req.url).searchParams.get('spaceId');
    if (!isContentId(spaceId)) return invalidInput('spaceId', headers);
    await requireQuestionSpace(db, ownerId, spaceId, { writable: false });
    return studyJson({ concepts: await listConcepts(db, ownerId, spaceId) }, 200, headers);
  });
}
