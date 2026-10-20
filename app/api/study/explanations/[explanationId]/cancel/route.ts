/** POST — cancel a pending explanation. A run still in progress stores nothing. */
import { cancelExplanation } from '@/lib/server/study/explanations/service';
import { studyExplanationsRoute, studyJson } from '@/lib/server/study/route';
import { StudyError } from '@/lib/server/study/spaces/repository';
import { isExplanationId } from '@/lib/study/explanations/contracts';

export const runtime = 'nodejs';

type Context = { params: Promise<{ explanationId: string }> };

export function POST(req: Request, context: Context) {
  return studyExplanationsRoute(req, async (ownerId, db, headers) => {
    const { explanationId } = await context.params;
    if (!isExplanationId(explanationId)) throw new StudyError('STUDY_EXPLANATION_NOT_FOUND');
    return studyJson(
      { explanation: await cancelExplanation(db, ownerId, explanationId) },
      200,
      headers,
    );
  });
}
