/**
 * GET  — retrieval readiness and the index state of every version of the
 *        space's materials (learning plan B03).
 * POST { targets: [{ materialId, versionId }] } — queue index builds (up to 50);
 *        each target reports `queued`, `up_to_date` or an error code.
 */
import { isStudyId } from '@/lib/study/spaces/contracts';
import { invalidInput, readStudyBody, studyJson, studyQaRoute } from '@/lib/server/study/route';
import { StudyError } from '@/lib/server/study/spaces/repository';
import { buildSpaceIndexes, spaceKnowledgeStatus } from '@/lib/server/study/knowledge/service';

export const runtime = 'nodejs';

type Context = { params: Promise<{ spaceId: string }> };

export function GET(req: Request, context: Context) {
  return studyQaRoute(req, async (ownerId, db, headers) => {
    const { spaceId } = await context.params;
    if (!isStudyId(spaceId)) throw new StudyError('STUDY_SPACE_NOT_FOUND');
    return studyJson({ knowledge: await spaceKnowledgeStatus(db, ownerId, spaceId) }, 200, headers);
  });
}

export function POST(req: Request, context: Context) {
  return studyQaRoute(req, async (ownerId, db, headers) => {
    const { spaceId } = await context.params;
    if (!isStudyId(spaceId)) throw new StudyError('STUDY_SPACE_NOT_FOUND');
    const body = await readStudyBody(req);
    const targets = body?.targets;
    if (
      !Array.isArray(targets) ||
      targets.length === 0 ||
      targets.length > 50 ||
      !targets.every(
        (target) =>
          target &&
          typeof target === 'object' &&
          isStudyId((target as Record<string, unknown>).materialId) &&
          isStudyId((target as Record<string, unknown>).versionId),
      )
    ) {
      return invalidInput('targets', headers);
    }
    const results = await buildSpaceIndexes(
      db,
      ownerId,
      spaceId,
      (targets as Array<{ materialId: string; versionId: string }>).map(
        ({ materialId, versionId }) => ({ materialId, versionId }),
      ),
    );
    return studyJson({ results }, 202, headers);
  });
}
