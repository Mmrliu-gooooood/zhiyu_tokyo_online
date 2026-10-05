/**
 * POST { providerId? } — parse this version with the chosen parser (default:
 * the free one for its type). Paid OCR parsers run only when named here.
 * `Idempotency-Key` makes retried clicks return the same task. 202 + task.
 */
import { isStudyId } from '@/lib/study/spaces/contracts';
import {
  invalidInput,
  readStudyBody,
  studyJson,
  studyMaterialsRoute,
} from '@/lib/server/study/route';
import { requestMaterialParse } from '@/lib/server/study/materials/service';
import { requireMaterialId } from '@/lib/server/study/materials/http';

export const runtime = 'nodejs';

type Context = { params: Promise<{ materialId: string; versionId: string }> };

export function POST(req: Request, context: Context) {
  return studyMaterialsRoute(req, async (ownerId, db, headers) => {
    const params = await context.params;
    const materialId = requireMaterialId(params.materialId);
    const versionId = requireMaterialId(params.versionId);
    const body = await readStudyBody(req);
    if (!body) return invalidInput('body', headers);
    const providerId = body.providerId;
    if (providerId !== undefined && !isStudyId(providerId)) {
      return invalidInput('providerId', headers);
    }
    const key = req.headers.get('idempotency-key')?.trim();
    if (key !== undefined && (key.length === 0 || key.length > 180)) {
      return invalidInput('idempotencyKey', headers);
    }
    const { task, created } = await requestMaterialParse(db, ownerId, materialId, versionId, {
      ...(typeof providerId === 'string' ? { providerId } : {}),
      ...(key ? { idempotencyKey: `client:${key}` } : {}),
    });
    return studyJson({ task, created }, 202, headers);
  });
}
