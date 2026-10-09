/**
 * DELETE: remove one learning record (and its correction). Its source stays
 * suppressed, so replaying the projection never brings it back.
 */
import { deleteLearningRecord } from '@/lib/server/study/memory/repository';
import { studyJson, studyMemoryRoute } from '@/lib/server/study/route';
import { StudyError } from '@/lib/server/study/spaces/repository';

export const runtime = 'nodejs';

type Context = { params: Promise<{ seq: string }> };

export function DELETE(req: Request, context: Context) {
  return studyMemoryRoute(req, async (ownerId, db, headers) => {
    const { seq } = await context.params;
    if (!/^[1-9][0-9]{0,14}$/.test(seq)) throw new StudyError('STUDY_MEMORY_RECORD_NOT_FOUND');
    await deleteLearningRecord(db, ownerId, Number(seq));
    return studyJson({ ok: true }, 200, headers);
  });
}
