/**
 * GET ?spaceId=&state=&source=&concept=&since=&offset= — one page of a
 * space's wrong items with filter counts (learning plan B10). Reads what the
 * last sync stored; the page calls /sync first when it opens.
 */
import type { NextRequest } from 'next/server';

import { invalidInput, studyJson, studyWrongbookRoute } from '@/lib/server/study/route';
import { listWrongbook } from '@/lib/server/study/wrongbook/service';
import { parseWrongbookFilter } from '@/lib/study/wrongbook/contracts';

export const runtime = 'nodejs';

const SPACE_ID = /^[\w-]{1,64}$/;

export function GET(req: NextRequest) {
  return studyWrongbookRoute(req, async (ownerId, db, headers) => {
    const params = req.nextUrl.searchParams;
    const spaceId = params.get('spaceId');
    if (!spaceId || !SPACE_ID.test(spaceId)) return invalidInput('spaceId', headers);
    const filter = parseWrongbookFilter(params);
    if (!filter) return invalidInput('filter', headers);
    return studyJson(await listWrongbook(db, ownerId, spaceId, filter), 200, headers);
  });
}
