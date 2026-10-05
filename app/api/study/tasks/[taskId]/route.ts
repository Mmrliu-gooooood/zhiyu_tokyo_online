/** GET — one learning task of the owner (status, attempts, error code, result summary). */
import { studyJson, studyMaterialsRoute } from '@/lib/server/study/route';
import { getLearningTask } from '@/lib/server/learning-tasks/repository';
import { LearningTaskError } from '@/lib/server/learning-tasks/contracts';

export const runtime = 'nodejs';

type Context = { params: Promise<{ taskId: string }> };

export function GET(req: Request, context: Context) {
  return studyMaterialsRoute(req, async (ownerId, db, headers) => {
    const task = await getLearningTask(db, ownerId, (await context.params).taskId);
    if (!task) throw new LearningTaskError('LEARNING_TASK_NOT_FOUND');
    return studyJson({ task }, 200, headers);
  });
}
