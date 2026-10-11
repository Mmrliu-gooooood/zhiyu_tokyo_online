/**
 * POST { blueprint }: which questions a paper would contain and every
 * shortfall (types or knowledge points the bank cannot cover). Writes
 * nothing; publishing with the returned seed freezes the same paper.
 */
import { previewPaper } from '@/lib/server/study/exams/service';
import { invalidInput, readStudyBody, studyExamsRoute, studyJson } from '@/lib/server/study/route';
import { parseBlueprint } from '@/lib/study/questions/blueprint';

export const runtime = 'nodejs';

export function POST(req: Request) {
  return studyExamsRoute(req, async (ownerId, db, headers) => {
    const body = await readStudyBody(req);
    if (!body) return invalidInput('body', headers);
    const parsed = parseBlueprint(body.blueprint);
    if (!parsed.ok) return invalidInput(parsed.field, headers);
    const preview = await previewPaper(db, ownerId, parsed.blueprint);
    return studyJson({ preview }, 200, headers);
  });
}
