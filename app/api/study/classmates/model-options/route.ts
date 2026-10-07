/**
 * GET: the connections a classmate may name as its independent answer model
 * (B05): platform text defaults, the owner's signed-in accounts and the
 * providers this server configured. Metadata only, never a key.
 */
import { studyClassmatesRoute, studyJson } from '@/lib/server/study/route';
import { listClassmateModelOptions } from '@/lib/server/study/companion/model-policy';

export const runtime = 'nodejs';

export function GET(req: Request) {
  return studyClassmatesRoute(req, async (ownerId, _db, headers) =>
    studyJson({ options: await listClassmateModelOptions(ownerId) }, 200, headers),
  );
}
