/**
 * GET  /api/study/materials[?spaceId=] — the owner's material library (or one space's).
 * POST /api/study/materials[?spaceId=&parse=0&providerId=] — upload a file as a new
 *   material. Same body contract as POST /api/materials: raw bytes, `content-type`,
 *   `x-material-filename`; optional `x-material-title`. The parse is queued with the
 *   default free parser unless `parse=0`; a parse that cannot be queued is reported
 *   in `parseNotStarted` while the upload stays stored.
 */
import { isStudyId } from '@/lib/study/spaces/contracts';
import { STUDY_MATERIAL_LIMITS } from '@/lib/study/materials/contracts';
import { invalidInput, studyJson, studyMaterialsRoute } from '@/lib/server/study/route';
import { listStudyMaterials } from '@/lib/server/study/materials/repository';
import { uploadStudyMaterial } from '@/lib/server/study/materials/service';
import {
  newUploadState,
  studyUploadMime,
  uploadRejection,
  uploadWarn,
} from '@/lib/server/study/materials/http';

export const runtime = 'nodejs';

export function GET(req: Request) {
  return studyMaterialsRoute(req, async (ownerId, db, headers) => {
    const spaceId = new URL(req.url).searchParams.get('spaceId');
    if (spaceId !== null && !isStudyId(spaceId)) return invalidInput('spaceId', headers);
    const materials = await listStudyMaterials(db, ownerId, spaceId ? { spaceId } : {});
    return studyJson({ materials }, 200, headers);
  });
}

function decodedTitle(req: Request): string | undefined {
  const raw = req.headers.get('x-material-title');
  if (!raw) return undefined;
  try {
    const title = decodeURIComponent(raw).trim();
    return title ? Array.from(title).slice(0, STUDY_MATERIAL_LIMITS.titleMax).join('') : undefined;
  } catch {
    return undefined;
  }
}

export function POST(req: Request) {
  return studyMaterialsRoute(req, async (ownerId, db, headers) => {
    const url = new URL(req.url);
    const spaceId = url.searchParams.get('spaceId');
    if (spaceId !== null && !isStudyId(spaceId)) return invalidInput('spaceId', headers);
    const providerId = url.searchParams.get('providerId') ?? undefined;
    if (providerId !== undefined && !isStudyId(providerId)) {
      return invalidInput('providerId', headers);
    }
    const state = newUploadState();
    try {
      const title = decodedTitle(req);
      const result = await uploadStudyMaterial(req, ownerId, db, {
        mime: studyUploadMime(req),
        ...(spaceId ? { spaceId } : {}),
        ...(title ? { title } : {}),
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
