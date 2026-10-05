/** GET [?artifact=] — one image extracted by a parse of this version. */
import { isStudyId } from '@/lib/study/spaces/contracts';
import { invalidInput, studyMaterialsRoute } from '@/lib/server/study/route';
import { readStudyMaterialImage } from '@/lib/server/study/materials/service';
import { privateFileResponse, requireMaterialId } from '@/lib/server/study/materials/http';

export const runtime = 'nodejs';

type Context = { params: Promise<{ materialId: string; versionId: string; imageId: string }> };

export function GET(req: Request, context: Context) {
  return studyMaterialsRoute(req, async (ownerId, db, headers) => {
    const params = await context.params;
    if (!isStudyId(params.imageId)) return invalidInput('imageId', headers);
    const artifactId = new URL(req.url).searchParams.get('artifact') ?? undefined;
    if (artifactId !== undefined && !isStudyId(artifactId)) {
      return invalidInput('artifact', headers);
    }
    const image = await readStudyMaterialImage(db, ownerId, {
      materialId: requireMaterialId(params.materialId),
      versionId: requireMaterialId(params.versionId),
      imageId: params.imageId,
      ...(artifactId ? { artifactId } : {}),
    });
    return privateFileResponse(image.bytes, image.mime, params.imageId, headers);
  });
}
