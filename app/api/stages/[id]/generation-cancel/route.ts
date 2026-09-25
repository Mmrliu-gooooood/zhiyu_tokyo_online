import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isCloudCourseLibraryEnabled } from '@/lib/config/feature-flags';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import {
  FOREGROUND_GENERATION_ROOT_HEADER,
  FOREGROUND_GENERATION_SESSION_HEADER,
  releaseForegroundGenerationRoot,
} from '@/lib/server/heavy-task-admission/foreground-generation';
import { getOwnerBoundStageAccessDb } from '@/lib/server/stage-access';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

/**
 * Release an abandoned client-driven generation root. The stage may not exist
 * yet (outline generation precedes the first durable document write), so this
 * route deliberately authenticates the owner but does not require a stage row.
 * The derived holder is owner-scoped and deletion is idempotent.
 */
export async function POST(req: NextRequest, { params }: Params) {
  if (!isCloudCourseLibraryEnabled()) return new Response('Not found', { status: 404 });

  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    const { id: stageId } = await params;
    if (!stageId.trim() || stageId.length > 500) {
      return NextResponse.json(
        { error: 'invalid_stage_id' },
        { status: 400, headers: responseHeaders },
      );
    }
    const rootStageId = req.headers.get(FOREGROUND_GENERATION_ROOT_HEADER)?.trim();
    const sessionId = req.headers.get(FOREGROUND_GENERATION_SESSION_HEADER)?.trim();
    if ((rootStageId && rootStageId !== stageId) || !sessionId || sessionId.length > 200) {
      return NextResponse.json(
        { error: 'invalid_generation_session' },
        { status: 400, headers: responseHeaders },
      );
    }
    try {
      await releaseForegroundGenerationRoot(
        ownerId,
        stageId,
        sessionId,
        await getOwnerBoundStageAccessDb(ownerId),
      );
      return NextResponse.json({ ok: true }, { status: 200, headers: responseHeaders });
    } catch (error) {
      console.error('Failed to release foreground generation root', {
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
