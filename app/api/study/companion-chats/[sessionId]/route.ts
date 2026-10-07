/**
 * GET: one after-class chat's header (learning plan B05) — the binding, the
 * classmate's CURRENT template, the space and the materials the classmate may
 * use now. The conversation itself is the agent session's event stream.
 */
import { readCompanionChat } from '@/lib/server/study/companion/service';
import { studyCompanionRoute, studyJson } from '@/lib/server/study/route';
import { StudyError } from '@/lib/server/study/spaces/repository';

export const runtime = 'nodejs';

type Context = { params: Promise<{ sessionId: string }> };

export function GET(req: Request, context: Context) {
  return studyCompanionRoute(req, async (ownerId, db, headers) => {
    const { sessionId } = await context.params;
    if (!/^[\w-]{1,128}$/.test(sessionId)) throw new StudyError('STUDY_COMPANION_CHAT_NOT_FOUND');
    return studyJson(await readCompanionChat(db, ownerId, sessionId), 200, headers);
  });
}
