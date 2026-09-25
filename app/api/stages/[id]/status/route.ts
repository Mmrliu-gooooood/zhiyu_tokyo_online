/**
 * GET /api/stages/[id]/status
 *
 * Returns the public-state metadata for a stage. Used by the Share menu CTA
 * to know whether to show "Publish" or "Already published · Unpublish".
 *
 * Legacy public state is readable without auth. Hosted courses require the
 * authenticated owner's database scope, like the document read itself.
 *
 * Convention: snake_case error codes (e.g. `not_found`, `internal_error`).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isCloudCourseLibraryEnabled } from '@/lib/config/feature-flags';
import { isHostedAuthEnabled } from '@/lib/auth/mode';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import { getOwnerBoundStageAccessDb, resolveStageAccess } from '@/lib/server/stage-access';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  if (!isCloudCourseLibraryEnabled()) return new Response('Not found', { status: 404 });

  const { id } = await params;
  if (isHostedAuthEnabled()) {
    return withRequestOwnerId(req, async (ownerId, headers) => {
      const db = await getOwnerBoundStageAccessDb(ownerId);
      const access = await resolveStageAccess(id, db);
      return access
        ? NextResponse.json({ isPublic: access.isPublic, publishedAt: access.publishedAt }, { headers })
        : NextResponse.json({ error: 'not_found' }, { status: 404, headers });
    });
  }
  try {
    const access = await resolveStageAccess(id);

    // Tombstoned and never-existed must be indistinguishable: this endpoint is
    // unauthenticated, so an answer other than plain 404 would let anyone
    // confirm that a given id used to be a real course.
    if (!access) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    // Field names are the wire contract; they stay `isPublic` / `publishedAt`
    // regardless of which layer answered.
    return NextResponse.json({ isPublic: access.isPublic, publishedAt: access.publishedAt });
  } catch (error) {
    console.error('Failed to fetch stage status', {
      stageId: id,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
