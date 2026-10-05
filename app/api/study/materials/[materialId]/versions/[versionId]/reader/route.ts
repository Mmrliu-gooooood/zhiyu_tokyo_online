/**
 * GET ?page=&artifact= — parsed blocks of one page (or the whole text for
 * formats without pages) of a specific version. `artifact` pins an older
 * parse of that version, so saved locations keep resolving after re-parses.
 */
import { isStudyId } from '@/lib/study/spaces/contracts';
import { invalidInput, studyJson, studyMaterialsRoute } from '@/lib/server/study/route';
import { readStudyMaterialPage } from '@/lib/server/study/materials/service';
import { requireMaterialId } from '@/lib/server/study/materials/http';

export const runtime = 'nodejs';

type Context = { params: Promise<{ materialId: string; versionId: string }> };

export function GET(req: Request, context: Context) {
  return studyMaterialsRoute(req, async (ownerId, db, headers) => {
    const params = await context.params;
    const url = new URL(req.url);
    const rawPage = url.searchParams.get('page');
    const page = rawPage === null ? undefined : Number(rawPage);
    if (page !== undefined && (!Number.isSafeInteger(page) || page < 1 || page > 100_000)) {
      return invalidInput('page', headers);
    }
    const artifactId = url.searchParams.get('artifact') ?? undefined;
    if (artifactId !== undefined && !isStudyId(artifactId)) {
      return invalidInput('artifact', headers);
    }
    const reader = await readStudyMaterialPage(db, ownerId, {
      materialId: requireMaterialId(params.materialId),
      versionId: requireMaterialId(params.versionId),
      ...(page !== undefined ? { page } : {}),
      ...(artifactId ? { artifactId } : {}),
    });
    return studyJson({ reader }, 200, headers);
  });
}
