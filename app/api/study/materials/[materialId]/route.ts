/**
 * GET    — one material: all versions, their parse state and newest task, the
 *          spaces it sits in, and the parsers available for its current file.
 * PATCH  — rename ({ title, revision }); a stale revision answers 409 with the current row.
 * DELETE — permanent delete: reads are revoked first, then objects, then rows.
 *          202 means object cleanup is still pending; repeating the call resumes it.
 */
import { isValidMaterialTitle } from '@/lib/study/materials/contracts';
import {
  invalidInput,
  readStudyBody,
  studyJson,
  studyMaterialsRoute,
} from '@/lib/server/study/route';
import { getStudyMaterial, renameStudyMaterial } from '@/lib/server/study/materials/repository';
import { materialParserOptions, purgeStudyMaterial } from '@/lib/server/study/materials/service';
import { requireMaterialId } from '@/lib/server/study/materials/http';

export const runtime = 'nodejs';

type Context = { params: Promise<{ materialId: string }> };

export function GET(req: Request, context: Context) {
  return studyMaterialsRoute(req, async (ownerId, db, headers) => {
    const materialId = requireMaterialId((await context.params).materialId);
    const material = await getStudyMaterial(db, ownerId, materialId);
    return studyJson(
      { material, parsers: materialParserOptions(material.current.mime) },
      200,
      headers,
    );
  });
}

export function PATCH(req: Request, context: Context) {
  return studyMaterialsRoute(req, async (ownerId, db, headers) => {
    const materialId = requireMaterialId((await context.params).materialId);
    const body = await readStudyBody(req);
    if (!isValidMaterialTitle(body?.title)) return invalidInput('title', headers);
    const revision = body?.revision;
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
      return invalidInput('revision', headers);
    }
    const material = await renameStudyMaterial(db, ownerId, materialId, body.title, revision);
    return studyJson({ material }, 200, headers);
  });
}

export function DELETE(req: Request, context: Context) {
  return studyMaterialsRoute(req, async (ownerId, db, headers) => {
    const materialId = requireMaterialId((await context.params).materialId);
    const result = await purgeStudyMaterial(db, ownerId, materialId);
    return studyJson(result, result.deleted ? 200 : 202, headers);
  });
}
