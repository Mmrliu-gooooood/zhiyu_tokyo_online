/**
 * POST /api/stages/[id]/generation-complete
 *
 * Monotonically marks an existing stage outline as generation-complete.
 * Owner-only. This route deliberately performs a narrow UPDATE so a stale
 * load-time repair cannot overwrite newer classroom content. With a
 * foreground session header it also releases that session's capacity lease in
 * the same transaction.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isCloudCourseLibraryEnabled } from '@/lib/config/feature-flags';
import { markStageGenerationComplete } from '@/lib/persistence/stage-meta';
import { getOwnerBoundStageAccessDb, resolveStageAccess } from '@/lib/server/stage-access';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import {
  FOREGROUND_GENERATION_ROOT_HEADER,
  FOREGROUND_GENERATION_SESSION_HEADER,
  releaseForegroundGenerationRoot,
} from '@/lib/server/heavy-task-admission/foreground-generation';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  if (!isCloudCourseLibraryEnabled()) return new Response('Not found', { status: 404 });

  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    const { id: stageId } = await params;
    const rootStageId = req.headers.get(FOREGROUND_GENERATION_ROOT_HEADER)?.trim();
    const sessionId = req.headers.get(FOREGROUND_GENERATION_SESSION_HEADER)?.trim();
    if ((rootStageId && rootStageId !== stageId) || (sessionId && sessionId.length > 200)) {
      return NextResponse.json(
        { error: 'invalid_generation_root' },
        { status: 400, headers: responseHeaders },
      );
    }
    try {
      const db = await getOwnerBoundStageAccessDb(ownerId);
      const access = await resolveStageAccess(stageId, db);

      // Absent and tombstoned are the same 404 — the caller must not learn
      // that an id used to be a real course, and a deleted course has no
      // state left worth repairing.
      if (!access) {
        return NextResponse.json({ error: 'not_found' }, { status: 404, headers: responseHeaders });
      }

      // Owner only.
      if (access.ownerId !== ownerId) {
        return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: responseHeaders });
      }

      // The client-driven foreground pipeline owns one course-level capacity
      // lease from its first outline request through the final durable save.
      // Mark and release commit together in one owner-bound transaction, so a
      // failed release rolls the mark back and never leaves "marked, still
      // holding the slot" behind. Both steps are idempotent, so retries are safe.
      const touched = await db.withTransaction(async (tx) => {
        if (!(await markStageGenerationComplete(tx, stageId))) return false;
        if (sessionId) await releaseForegroundGenerationRoot(ownerId, stageId, sessionId, tx);
        return true;
      });

      if (!touched) {
        return NextResponse.json({ error: 'not_found' }, { status: 404, headers: responseHeaders });
      }

      console.info('Stage generation marked complete', { stageId, ownerId });
      return NextResponse.json({ ok: true }, { status: 200, headers: responseHeaders });
    } catch (error) {
      console.error('Failed to mark stage generation complete', {
        stageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return NextResponse.json(
        { error: 'internal_error' },
        { status: 500, headers: responseHeaders },
      );
    }
  });
}
