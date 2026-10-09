/**
 * POST { text, spaceId?, origin?, correctsKey?, evidence? }: add a fact the
 * student wrote ("我在准备期中考试"), or — with correctsKey — a correction
 * attached to one learning record (the record itself is kept).
 */
import { createFact } from '@/lib/server/study/memory/repository';
import { invalidInput, readStudyBody, studyJson, studyMemoryRoute } from '@/lib/server/study/route';
import { parseEvidence, parseFactText } from '@/lib/study/memory/contracts';
import { isContentId } from '@/lib/study/spaces/contracts';

export const runtime = 'nodejs';

export function POST(req: Request) {
  return studyMemoryRoute(req, async (ownerId, db, headers) => {
    const body = await readStudyBody(req);
    if (!body) return invalidInput('body', headers);
    const text = parseFactText(body.text);
    if (!text) return invalidInput('text', headers);
    const spaceId = body.spaceId ?? null;
    if (spaceId !== null && !isContentId(spaceId)) return invalidInput('spaceId', headers);
    const correctsKey = body.correctsKey ?? null;
    if (
      correctsKey !== null &&
      (typeof correctsKey !== 'string' || correctsKey.length === 0 || correctsKey.length > 400)
    ) {
      return invalidInput('correctsKey', headers);
    }
    const origin = body.origin ?? (correctsKey ? 'correction' : 'manual');
    if (origin !== 'manual' && origin !== 'confirmed_prompt' && origin !== 'correction') {
      return invalidInput('origin', headers);
    }
    if ((origin === 'correction') !== (correctsKey !== null)) {
      return invalidInput('correctsKey', headers);
    }
    const evidence = parseEvidence(body.evidence);
    if (evidence === undefined) return invalidInput('evidence', headers);
    const fact = await createFact(db, ownerId, {
      text,
      spaceId: spaceId as string | null,
      origin,
      correctsKey: correctsKey as string | null,
      evidence,
    });
    return studyJson({ fact }, 201, headers);
  });
}
