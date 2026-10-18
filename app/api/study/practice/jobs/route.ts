/**
 * POST — start an AI practice job after the student confirmed its plan
 * (learning plan B11). No model is called here; the page then runs the job
 * step by step (`/run`).
 *
 * - `{ kind: 'paper', blueprint (with the preview's seed), mode: 'mixed' | 'ai',
 *   materialVersionIds?, consent: true, idempotencyKey }`: write the gap of a
 *   mixed paper, or every section of an AI paper, from the subject's materials.
 * - `{ kind: 'variant', wrongItemId, count (1–3), consent: true, idempotencyKey }`:
 *   write variants of one wrong question.
 *
 * 201 with `{ job }` (a repeated request returns the same job).
 */
import { createPaperJob, createVariantJob } from '@/lib/server/study/practice/service';
import {
  invalidInput,
  isStudyGradingEnabled,
  isStudyWrongbookEnabled,
  readStudyBody,
  studyJson,
  studyPracticeRoute,
} from '@/lib/server/study/route';
import { isRequestKey } from '@/lib/study/assessments/contracts';
import { PRACTICE_LIMITS } from '@/lib/study/practice/contracts';
import { parseBlueprint } from '@/lib/study/questions/blueprint';
import { isWrongItemId } from '@/lib/study/wrongbook/contracts';

export const runtime = 'nodejs';

function versionIds(value: unknown): string[] | null | undefined {
  if (value === undefined || value === null) return null;
  if (
    !Array.isArray(value) ||
    value.length > PRACTICE_LIMITS.materialVersions ||
    !value.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 120)
  ) {
    return undefined;
  }
  return [...new Set(value as string[])];
}

export function POST(req: Request) {
  return studyPracticeRoute(req, async (ownerId, db, headers) => {
    const body = await readStudyBody(req);
    if (!body) return invalidInput('body', headers);
    if (!isRequestKey(body.idempotencyKey)) return invalidInput('idempotencyKey', headers);
    const consent = body.consent === true;
    if (body.kind === 'paper') {
      const parsed = parseBlueprint(body.blueprint, { allowOpen: isStudyGradingEnabled() });
      if (!parsed.ok) return invalidInput(parsed.field, headers);
      const seed = parsed.blueprint.seed;
      if (!seed) return invalidInput('seed', headers);
      if (body.mode !== 'mixed' && body.mode !== 'ai') return invalidInput('mode', headers);
      const materials = versionIds(body.materialVersionIds);
      if (materials === undefined) return invalidInput('materialVersionIds', headers);
      const job = await createPaperJob(db, ownerId, {
        blueprint: { ...parsed.blueprint, seed },
        mode: body.mode,
        materialVersionIds: materials,
        consent,
        idempotencyKey: body.idempotencyKey,
      });
      return studyJson({ job }, 201, headers);
    }
    if (body.kind === 'variant') {
      if (!isStudyWrongbookEnabled()) return invalidInput('kind', headers);
      if (!isWrongItemId(body.wrongItemId)) return invalidInput('wrongItemId', headers);
      if (!Number.isInteger(body.count)) return invalidInput('count', headers);
      const job = await createVariantJob(db, ownerId, {
        wrongItemId: body.wrongItemId,
        count: body.count as number,
        consent,
        idempotencyKey: body.idempotencyKey,
      });
      return studyJson({ job }, 201, headers);
    }
    return invalidInput('kind', headers);
  });
}
