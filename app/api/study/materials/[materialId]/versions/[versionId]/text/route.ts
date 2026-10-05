/**
 * GET — the version's reusable parsed text, as course generation and agent
 * sessions consume it (no re-parse).
 */
import { studyJson, studyMaterialsRoute } from '@/lib/server/study/route';
import { readStudyMaterialText } from '@/lib/server/study/materials/service';
import { requireMaterialId } from '@/lib/server/study/materials/http';

export const runtime = 'nodejs';

type Context = { params: Promise<{ materialId: string; versionId: string }> };

export function GET(req: Request, context: Context) {
  return studyMaterialsRoute(req, async (ownerId, db, headers) => {
    const params = await context.params;
    const { version, text, truncated } = await readStudyMaterialText(db, ownerId, {
      materialId: requireMaterialId(params.materialId),
      versionId: requireMaterialId(params.versionId),
    });
    return studyJson(
      {
        materialId: version.materialId,
        versionId: version.versionId,
        versionNo: version.versionNo,
        name: version.originalName,
        title: version.title,
        artifactId: version.artifact?.artifactId ?? null,
        pageCount: version.artifact?.pageCount ?? 0,
        text,
        truncated,
      },
      200,
      headers,
    );
  });
}
