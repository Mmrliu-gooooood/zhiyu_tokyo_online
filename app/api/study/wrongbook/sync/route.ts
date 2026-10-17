/**
 * POST { spaceId, force? } — bring a space's wrong items up to date from its
 * submitted papers, classroom quizzes and learning checks (learning plan
 * B10). Bounded and throttled; replaying never duplicates anything.
 */
import {
  invalidInput,
  readStudyBody,
  studyJson,
  studyWrongbookRoute,
} from '@/lib/server/study/route';
import { syncWrongbook } from '@/lib/server/study/wrongbook/service';

export const runtime = 'nodejs';

const SPACE_ID = /^[\w-]{1,64}$/;

export function POST(req: Request) {
  return studyWrongbookRoute(req, async (ownerId, db, headers) => {
    const body = await readStudyBody(req);
    if (!body) return invalidInput('body', headers);
    if (typeof body.spaceId !== 'string' || !SPACE_ID.test(body.spaceId)) {
      return invalidInput('spaceId', headers);
    }
    if (body.force !== undefined && typeof body.force !== 'boolean') {
      return invalidInput('force', headers);
    }
    const result = await syncWrongbook(db, ownerId, body.spaceId, { force: body.force === true });
    return studyJson(result, 200, headers);
  });
}
