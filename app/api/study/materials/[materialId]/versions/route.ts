/**
 * POST — replace the material's file with a new immutable version (same upload
 * contract as POST /api/study/materials). Older versions, their parses and
 * anything pointing at them stay readable.
 */
import { isStudyId } from '@/lib/study/spaces/contracts';
import { invalidInput, studyJson, studyMaterialsRoute } from '@/lib/server/study/route';
import { uploadStudyMaterial } from '@/lib/server/study/materials/service';
import {
  newUploadState,
  requireMaterialId,
  studyUploadMime,
  uploadRejection,
  uploadWarn,
} from '@/lib/server/study/materials/http';

export const runtime = 'nodejs';

type Context = { params: Promise<{ materialId: string }> };

export function POST(req: Request, context: Context) {
  return studyMaterialsRoute(req, async (ownerId, db, headers) => {
    const materialId = requireMaterialId((await context.params).materialId);
    const url = new URL(req.url);
    const providerId = url.searchParams.get('providerId') ?? undefined;
    if (providerId !== undefined && !isStudyId(providerId)) {
      return invalidInput('providerId', headers);
    }
    const state = newUploadState();
    try {
      const result = await uploadStudyMaterial(req, ownerId, db, {
        mime: studyUploadMime(req),
        materialId,
        parse: url.searchParams.get('parse') !== '0',
        ...(providerId ? { providerId } : {}),
        state,
        warn: uploadWarn(state),
      });
      return studyJson(result, 201, headers);
    } catch (error) {
      return uploadRejection(error, headers);
    }
  });
}
