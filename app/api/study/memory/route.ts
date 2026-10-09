/**
 * GET: the Memory page (learning plan B06) — switches, preferences, facts,
 * subject goals, learning records and the rule-based recent state. Replays
 * the learning-event projection first (rule-based, no model calls).
 */
import { readMemoryOverview } from '@/lib/server/study/memory/service';
import { studyJson, studyMemoryRoute } from '@/lib/server/study/route';

export const runtime = 'nodejs';

export function GET(req: Request) {
  return studyMemoryRoute(req, async (ownerId, db, headers) =>
    studyJson(await readMemoryOverview(db, ownerId), 200, headers),
  );
}
