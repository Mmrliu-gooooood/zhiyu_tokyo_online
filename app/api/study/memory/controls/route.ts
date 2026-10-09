/**
 * PUT { spaceId: string | null, enabled, baseRevision? }: the global switch
 * (spaceId null) or one subject's. Off stops personalised reads (no Memory
 * in after-class answers from the next turn) and derived writes (no new
 * learning records); viewing, editing and clearing keep working. Facts
 * saved before the switch goes off are recorded first (see switchMemory).
 */
import { switchMemory } from '@/lib/server/study/memory/service';
import { invalidInput, readStudyBody, studyJson, studyMemoryRoute } from '@/lib/server/study/route';
import { isContentId } from '@/lib/study/spaces/contracts';

export const runtime = 'nodejs';

export function PUT(req: Request) {
  return studyMemoryRoute(req, async (ownerId, db, headers) => {
    const body = await readStudyBody(req);
    if (!body) return invalidInput('body', headers);
    const spaceId = body.spaceId ?? null;
    if (spaceId !== null && (typeof spaceId !== 'string' || !isContentId(spaceId))) {
      return invalidInput('spaceId', headers);
    }
    if (typeof body.enabled !== 'boolean') return invalidInput('enabled', headers);
    const baseRevision = body.baseRevision;
    if (
      baseRevision !== undefined &&
      (typeof baseRevision !== 'number' || !Number.isInteger(baseRevision) || baseRevision < 0)
    ) {
      return invalidInput('baseRevision', headers);
    }
    const control = await switchMemory(
      db,
      ownerId,
      spaceId as string | null,
      body.enabled,
      baseRevision as number | undefined,
    );
    return studyJson({ control }, 200, headers);
  });
}
