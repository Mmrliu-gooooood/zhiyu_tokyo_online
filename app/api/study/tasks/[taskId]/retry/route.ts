/** POST — re-queue a failed or cancelled task with a fresh attempt budget. */
import { studyJson, studyMaterialsRoute } from '@/lib/server/study/route';
import {
  isLearningTaskWorkerLive,
  retryLearningTask,
} from '@/lib/server/learning-tasks/repository';
import { isStudyTaskIntakeOpen } from '@/lib/server/study/flags';
import { StudyError } from '@/lib/server/study/spaces/repository';

export const runtime = 'nodejs';

type Context = { params: Promise<{ taskId: string }> };

export function POST(req: Request, context: Context) {
  return studyMaterialsRoute(req, async (ownerId, db, headers) => {
    const { taskId } = await context.params;
    if (!isStudyTaskIntakeOpen() || !(await isLearningTaskWorkerLive(db))) {
      throw new StudyError('STUDY_TASKS_UNAVAILABLE');
    }
    const task = await db.withTransaction((tx) => retryLearningTask(tx, ownerId, taskId));
    return studyJson({ task }, 202, headers);
  });
}
