/** DELETE — remove a material from the space only; it stays in the library. */
import { isStudyId } from '@/lib/study/spaces/contracts';
import { studyJson, studyMaterialsRoute } from '@/lib/server/study/route';
import { StudyError } from '@/lib/server/study/spaces/repository';
import { unlinkStudySpaceMaterial } from '@/lib/server/study/materials/repository';

export const runtime = 'nodejs';

type Context = { params: Promise<{ spaceId: string; materialId: string }> };

export function DELETE(req: Request, context: Context) {
  return studyMaterialsRoute(req, async (ownerId, db, headers) => {
    const { spaceId, materialId } = await context.params;
    if (!isStudyId(spaceId)) throw new StudyError('STUDY_SPACE_NOT_FOUND');
    if (!isStudyId(materialId)) throw new StudyError('STUDY_MATERIAL_NOT_FOUND');
    await unlinkStudySpaceMaterial(db, ownerId, spaceId, materialId);
    return studyJson({ removed: true }, 200, headers);
  });
}
