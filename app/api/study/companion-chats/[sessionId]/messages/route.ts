/**
 * POST { text, discuss?, modelRef? }: the next question of an after-class chat
 * (learning plan B05). Checked here before it becomes durable: the chat must
 * be the caller's, its classmate and space still active, and the hourly
 * message cap not reached. The run itself re-resolves everything again.
 */
import {
  cleanQuestion,
  companionFailure,
  parseDiscuss,
  postCompanionMessage,
} from '@/lib/server/study/companion/service';
import {
  invalidInput,
  readStudyBody,
  studyCompanionRoute,
  studyJson,
} from '@/lib/server/study/route';
import { StudyError } from '@/lib/server/study/spaces/repository';

export const runtime = 'nodejs';

type Context = { params: Promise<{ sessionId: string }> };

export function POST(req: Request, context: Context) {
  return studyCompanionRoute(req, async (ownerId, db, headers) => {
    const { sessionId } = await context.params;
    if (!/^[\w-]{1,128}$/.test(sessionId)) throw new StudyError('STUDY_COMPANION_CHAT_NOT_FOUND');
    const body = await readStudyBody(req);
    if (!body) return invalidInput('body', headers);
    const text = cleanQuestion(body.text);
    if (!text) return invalidInput('text', headers);
    const discuss = parseDiscuss(body.discuss);
    if (!discuss) return invalidInput('discuss', headers);
    try {
      const posted = await postCompanionMessage(db, ownerId, sessionId, {
        text,
        discuss,
        modelRef: body.modelRef,
      });
      return studyJson(posted, 202, headers);
    } catch (error) {
      const mapped = companionFailure(error, headers);
      if (mapped) return mapped;
      throw error;
    }
  });
}
