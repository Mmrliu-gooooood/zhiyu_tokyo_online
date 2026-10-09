/** PATCH { text, spaceId?, baseRevision }: correct a fact. DELETE: remove it. */
import { deleteFact, updateFact } from '@/lib/server/study/memory/repository';
import { invalidInput, readStudyBody, studyJson, studyMemoryRoute } from '@/lib/server/study/route';
import { StudyError } from '@/lib/server/study/spaces/repository';
import { parseFactText } from '@/lib/study/memory/contracts';
import { isContentId } from '@/lib/study/spaces/contracts';

export const runtime = 'nodejs';

type Context = { params: Promise<{ factId: string }> };

function validId(value: string): boolean {
  return /^mf-[0-9a-f]{16}$/.test(value);
}

export function PATCH(req: Request, context: Context) {
  return studyMemoryRoute(req, async (ownerId, db, headers) => {
    const { factId } = await context.params;
    if (!validId(factId)) throw new StudyError('STUDY_MEMORY_FACT_NOT_FOUND');
    const body = await readStudyBody(req);
    if (!body) return invalidInput('body', headers);
    const text = parseFactText(body.text);
    if (!text) return invalidInput('text', headers);
    if (body.spaceId !== undefined && body.spaceId !== null && !isContentId(body.spaceId)) {
      return invalidInput('spaceId', headers);
    }
    if (typeof body.baseRevision !== 'number' || !Number.isInteger(body.baseRevision)) {
      return invalidInput('baseRevision', headers);
    }
    const fact = await updateFact(db, ownerId, factId, {
      text,
      spaceId: body.spaceId as string | null | undefined,
      baseRevision: body.baseRevision,
    });
    return studyJson({ fact }, 200, headers);
  });
}

export function DELETE(req: Request, context: Context) {
  return studyMemoryRoute(req, async (ownerId, db, headers) => {
    const { factId } = await context.params;
    if (!validId(factId)) throw new StudyError('STUDY_MEMORY_FACT_NOT_FOUND');
    await deleteFact(db, ownerId, factId);
    return studyJson({ ok: true }, 200, headers);
  });
}
