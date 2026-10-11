/** GET: the official question packs (read-only public catalogue) with attribution and licence. */
import { studyExamsRoute, studyJson } from '@/lib/server/study/route';
import { OFFICIAL_PACKS, packSummary } from '@/lib/study/questions/packs';

export const runtime = 'nodejs';

export function GET(req: Request) {
  return studyExamsRoute(req, async (_ownerId, _db, headers) =>
    studyJson({ packs: OFFICIAL_PACKS.map(packSummary) }, 200, headers),
  );
}
