/** POST { materialId } — add an existing library material to the space (idempotent). */
import { isStudyId } from '@/lib/study/spaces/contracts';
import {
  invalidInput,
  readStudyBody,
  studyJson,
  studyMaterialsRoute,
} from '@/lib/server/study/route';
import { StudyError } from '@/lib/server/study/spaces/repository';
import { linkStudySpaceMaterial } from '@/lib/server/study/materials/repository';

export const runtime = 'nodejs';

type Context = { params: Promise<{ spaceId: string }> };

export function POST(req: Request, context: Context) {
  return studyMaterialsRoute(req, async (ownerId, db, headers) => {
    const { spaceId } = await context.params;
    if (!isStudyId(spaceId)) throw new StudyError('STUDY_SPACE_NOT_FOUND');
    const body = await readStudyBody(req);
    const materialId = body?.materialId;
    if (!isStudyId(materialId)) return invalidInput('materialId', headers);
    const result = await linkStudySpaceMaterial(db, ownerId, spaceId, materialId);
    return studyJson(result, result.created ? 201 : 200, headers);
  });
}
