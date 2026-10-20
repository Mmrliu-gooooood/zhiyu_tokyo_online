/**
 * GET — one explanation with its content and cited material passages.
 * DELETE — delete it (a course it started stays in the subject).
 */
import { deleteExplanation, getExplanationDetail } from '@/lib/server/study/explanations/service';
import { studyExplanationsRoute, studyJson } from '@/lib/server/study/route';
import { StudyError } from '@/lib/server/study/spaces/repository';
import { isExplanationId } from '@/lib/study/explanations/contracts';

export const runtime = 'nodejs';

type Context = { params: Promise<{ explanationId: string }> };

export function GET(req: Request, context: Context) {
  return studyExplanationsRoute(req, async (ownerId, db, headers) => {
    const { explanationId } = await context.params;
    if (!isExplanationId(explanationId)) throw new StudyError('STUDY_EXPLANATION_NOT_FOUND');
    return studyJson(
      { explanation: await getExplanationDetail(db, ownerId, explanationId) },
      200,
      headers,
    );
  });
}

export function DELETE(req: Request, context: Context) {
  return studyExplanationsRoute(req, async (ownerId, db, headers) => {
    const { explanationId } = await context.params;
    if (!isExplanationId(explanationId)) throw new StudyError('STUDY_EXPLANATION_NOT_FOUND');
    await deleteExplanation(db, ownerId, explanationId);
    return studyJson({ deleted: true }, 200, headers);
  });
}
