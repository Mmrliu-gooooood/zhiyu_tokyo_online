/**
 * GET: a paper with its attempts (no items: they are served through an
 * attempt, without keys until submitted). DELETE: remove the paper with its
 * attempts; learning records already made from them stay until cleared in
 * Memory.
 */
import { deletePaper, getPaperSummary } from '@/lib/server/study/exams/repository';
import { studyExamsRoute, studyJson } from '@/lib/server/study/route';
import { StudyError } from '@/lib/server/study/spaces/repository';
import { isPaperId } from '@/lib/study/assessments/contracts';

export const runtime = 'nodejs';

type Context = { params: Promise<{ paperId: string }> };

async function paperIdOf(context: Context): Promise<string> {
  const { paperId } = await context.params;
  if (!isPaperId(paperId)) throw new StudyError('STUDY_PAPER_NOT_FOUND');
  return paperId;
}

export function GET(req: Request, context: Context) {
  return studyExamsRoute(req, async (ownerId, db, headers) => {
    const paper = await getPaperSummary(db, ownerId, await paperIdOf(context));
    return studyJson({ paper }, 200, headers);
  });
}

export function DELETE(req: Request, context: Context) {
  return studyExamsRoute(req, async (ownerId, db, headers) => {
    await deletePaper(db, ownerId, await paperIdOf(context));
    return studyJson({ deleted: true }, 200, headers);
  });
}
