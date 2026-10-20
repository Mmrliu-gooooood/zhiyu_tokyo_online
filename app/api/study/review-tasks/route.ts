/**
 * GET ?spaceId=&tz= — a space's review list (learning plan B12): today's
 * tasks within the student's minutes, what comes later, stable items, the
 * skipped ones and the evidence per knowledge point. Syncs the wrong-answer
 * book first (throttled) and recomputes only changed cards. `tz` is the
 * page's time zone, used when the space has none. No model calls.
 */
import type { NextRequest } from 'next/server';

import { reviewOverview } from '@/lib/server/study/review/service';
import { invalidInput, studyJson, studyReviewRoute } from '@/lib/server/study/route';

export const runtime = 'nodejs';

const SPACE_ID = /^[\w-]{1,64}$/;
const TIME_ZONE = /^[A-Za-z0-9_+\-/]{1,64}$/;

export function GET(req: NextRequest) {
  return studyReviewRoute(req, async (ownerId, db, headers) => {
    const params = req.nextUrl.searchParams;
    const spaceId = params.get('spaceId');
    if (!spaceId || !SPACE_ID.test(spaceId)) return invalidInput('spaceId', headers);
    const tz = params.get('tz');
    if (tz !== null && !TIME_ZONE.test(tz)) return invalidInput('tz', headers);
    return studyJson(
      { overview: await reviewOverview(db, ownerId, spaceId, { timezone: tz }) },
      200,
      headers,
    );
  });
}
