/** GET: one official pack with its questions (public content, answers included). */
import { studyExamsRoute, studyJson } from '@/lib/server/study/route';
import { StudyError } from '@/lib/server/study/spaces/repository';
import { findPack, packSummary } from '@/lib/study/questions/packs';

export const runtime = 'nodejs';

type Context = { params: Promise<{ packId: string }> };

export function GET(req: Request, context: Context) {
  return studyExamsRoute(req, async (_ownerId, _db, headers) => {
    const pack = findPack((await context.params).packId);
    if (!pack) throw new StudyError('STUDY_PACK_NOT_FOUND');
    return studyJson({ pack: packSummary(pack), questions: pack.questions }, 200, headers);
  });
}
