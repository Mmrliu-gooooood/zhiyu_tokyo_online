/**
 * POST: start the paper, or continue its open attempt (one open attempt per
 * paper, so a second device resumes the same draft). Returns the attempt
 * without any answer key.
 */
import { getAttemptView, openAttempt } from '@/lib/server/study/exams/repository';
import { studyExamsRoute, studyJson } from '@/lib/server/study/route';
import { StudyError } from '@/lib/server/study/spaces/repository';
import { isPaperId } from '@/lib/study/assessments/contracts';

export const runtime = 'nodejs';

type Context = { params: Promise<{ paperId: string }> };

export function POST(req: Request, context: Context) {
  return studyExamsRoute(req, async (ownerId, db, headers) => {
    const { paperId } = await context.params;
    if (!isPaperId(paperId)) throw new StudyError('STUDY_PAPER_NOT_FOUND');
    const opened = await openAttempt(db, ownerId, paperId);
    const attempt = await getAttemptView(db, ownerId, opened.id);
    return studyJson({ attempt }, opened.created ? 201 : 200, headers);
  });
}
