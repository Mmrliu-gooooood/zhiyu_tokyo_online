/** POST — cancel a queued or running task; a running worker is fenced out. Idempotent. */
import { studyJson, studyMaterialsRoute } from '@/lib/server/study/route';
import { cancelLearningTask } from '@/lib/server/learning-tasks/repository';

export const runtime = 'nodejs';

type Context = { params: Promise<{ taskId: string }> };

export function POST(req: Request, context: Context) {
  return studyMaterialsRoute(req, async (ownerId, db, headers) => {
    const { taskId } = await context.params;
    const task = await db.withTransaction((tx) => cancelLearningTask(tx, ownerId, taskId));
    return studyJson({ task }, 200, headers);
  });
}
