/** GET [?download=1] — the original uploaded bytes of one version (owner only). */
import { studyMaterialsRoute } from '@/lib/server/study/route';
import { readStudyMaterialFile } from '@/lib/server/study/materials/service';
import { privateFileResponse, requireMaterialId } from '@/lib/server/study/materials/http';

export const runtime = 'nodejs';

type Context = { params: Promise<{ materialId: string; versionId: string }> };

export function GET(req: Request, context: Context) {
  return studyMaterialsRoute(req, async (ownerId, db, headers) => {
    const params = await context.params;
    const { version, bytes } = await readStudyMaterialFile(db, ownerId, {
      materialId: requireMaterialId(params.materialId),
      versionId: requireMaterialId(params.versionId),
    });
    const download = new URL(req.url).searchParams.get('download') === '1';
    return privateFileResponse(
      bytes,
      version.mime,
      version.originalName,
      headers,
      download ? 'attachment' : 'inline',
    );
  });
}
