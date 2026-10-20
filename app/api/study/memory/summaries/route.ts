/**
 * A study space's short Memory summary (learning plan B12).
 *
 * POST { spaceId } + model-selection headers — bring it up to date: the
 *   student's model is called only when the space's records changed enough
 *   since the stored summary (never for unchanged records), at most once per
 *   interval and a few times a day. Memory off: nothing is written and the
 *   stored summary is deleted. Responds with `{ state, reason, summary }`.
 * DELETE ?spaceId= — the student deletes it; the same records never rebuild it.
 */
import type { NextRequest } from 'next/server';

import { deleteSummary, refreshSpaceSummary } from '@/lib/server/study/memory/summary';
import {
  invalidInput,
  isStudyMemoryEnabled,
  readStudyBody,
  studyJson,
  studyReviewRoute,
} from '@/lib/server/study/route';
import { assertSpace } from '@/lib/server/study/wrongbook/repository';

export const runtime = 'nodejs';
export const maxDuration = 120;

const SPACE_ID = /^[\w-]{1,64}$/;

function notFound() {
  return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
}

export function POST(req: Request) {
  return studyReviewRoute(req, async (ownerId, db, headers) => {
    if (!isStudyMemoryEnabled()) return notFound();
    const body = await readStudyBody(req);
    if (!body) return invalidInput('body', headers);
    if (typeof body.spaceId !== 'string' || !SPACE_ID.test(body.spaceId)) {
      return invalidInput('spaceId', headers);
    }
    await assertSpace(db, ownerId, body.spaceId);
    return refreshSpaceSummary(req, db, ownerId, body.spaceId, body, headers);
  });
}

export function DELETE(req: NextRequest) {
  return studyReviewRoute(req, async (ownerId, db, headers) => {
    if (!isStudyMemoryEnabled()) return notFound();
    const spaceId = req.nextUrl.searchParams.get('spaceId');
    if (!spaceId || !SPACE_ID.test(spaceId)) return invalidInput('spaceId', headers);
    await assertSpace(db, ownerId, spaceId);
    await deleteSummary(db, ownerId, spaceId);
    return studyJson({ deleted: true }, 200, headers);
  });
}
