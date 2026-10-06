/**
 * DELETE — remove the search index of one material version (learning plan
 * B03). The material, its parse and saved answers stay; a running build is
 * cancelled. Rebuilding is a new index request.
 */
import { isStudyId } from '@/lib/study/spaces/contracts';
import { studyJson, studyQaRoute } from '@/lib/server/study/route';
import { StudyError } from '@/lib/server/study/spaces/repository';
import { deleteStudyVersionIndexes } from '@/lib/server/study/knowledge/repository';
import { knowledgeStorageReady } from '@/lib/server/study/knowledge/repository';

export const runtime = 'nodejs';

type Context = { params: Promise<{ materialId: string; versionId: string }> };

export function DELETE(req: Request, context: Context) {
  return studyQaRoute(req, async (ownerId, db, headers) => {
    const { materialId, versionId } = await context.params;
    if (!isStudyId(materialId) || !isStudyId(versionId)) {
      throw new StudyError('STUDY_MATERIAL_NOT_FOUND');
    }
    if (!(await knowledgeStorageReady(db))) throw new StudyError('STUDY_QA_UNAVAILABLE');
    const removed = await deleteStudyVersionIndexes(db, ownerId, materialId, versionId);
    return studyJson({ removed }, 200, headers);
  });
}
