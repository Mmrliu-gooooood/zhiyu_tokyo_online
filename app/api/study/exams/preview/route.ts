/**
 * POST { blueprint, mode? }: which questions a paper would contain and every
 * shortfall (types or knowledge points the bank cannot cover). Writes
 * nothing; publishing with the returned seed freezes the same paper.
 *
 * `mode` (B11, practice on): `mixed` adds the plan for writing only the
 * shortfalls with AI, `ai` the plan for writing every section — counts,
 * knowledge points, the subject's materials and the call cap the student
 * confirms before any model is called. `bank` (default) is B07 unchanged.
 */
import { previewPaper } from '@/lib/server/study/exams/service';
import { previewPracticePaper } from '@/lib/server/study/practice/service';
import {
  invalidInput,
  isStudyGradingEnabled,
  isStudyPracticeEnabled,
  readStudyBody,
  studyExamsRoute,
  studyJson,
} from '@/lib/server/study/route';
import { parseBlueprint } from '@/lib/study/questions/blueprint';

export const runtime = 'nodejs';

export function POST(req: Request) {
  return studyExamsRoute(req, async (ownerId, db, headers) => {
    const body = await readStudyBody(req);
    if (!body) return invalidInput('body', headers);
    const parsed = parseBlueprint(body.blueprint, { allowOpen: isStudyGradingEnabled() });
    if (!parsed.ok) return invalidInput(parsed.field, headers);
    const mode = body.mode ?? 'bank';
    if (mode !== 'bank' && mode !== 'mixed' && mode !== 'ai') return invalidInput('mode', headers);
    if (mode !== 'bank' && !isStudyPracticeEnabled()) return invalidInput('mode', headers);
    const preview =
      mode === 'bank'
        ? await previewPaper(db, ownerId, parsed.blueprint)
        : await previewPracticePaper(db, ownerId, parsed.blueprint, mode);
    return studyJson({ preview }, 200, headers);
  });
}
