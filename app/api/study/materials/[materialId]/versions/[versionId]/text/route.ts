/**
 * GET — the version's reusable parse output, as course generation and agent
 * sessions consume it (no re-parse): the text plus the metadata of the images
 * the parse extracted (their bytes come from the image endpoint).
 */
import { studyJson, studyMaterialsRoute } from '@/lib/server/study/route';
import { readStudyMaterialText } from '@/lib/server/study/materials/service';
import { requireMaterialId } from '@/lib/server/study/materials/http';
import type { StudyMaterialTextView } from '@/lib/study/materials/contracts';

export const runtime = 'nodejs';

type Context = { params: Promise<{ materialId: string; versionId: string }> };

export function GET(req: Request, context: Context) {
  return studyMaterialsRoute(req, async (ownerId, db, headers) => {
    const params = await context.params;
    const { version, text, truncated, images } = await readStudyMaterialText(db, ownerId, {
      materialId: requireMaterialId(params.materialId),
      versionId: requireMaterialId(params.versionId),
    });
    const body: StudyMaterialTextView = {
      materialId: version.materialId,
      versionId: version.versionId,
      versionNo: version.versionNo,
      name: version.originalName,
      title: version.title,
      artifactId: version.artifact?.artifactId ?? null,
      pageCount: version.artifact?.pageCount ?? 0,
      text,
      truncated,
      images,
    };
    return studyJson(body, 200, headers);
  });
}
