/**
 * PUT { spaceId, dailyMinutes, revision } — how many minutes a day the
 * student has for review in a space (learning plan B12); the daily list is
 * cut to it. `revision` 0 creates the setting; a stale one is 409 with the
 * current setting.
 */
import { putReviewSettings } from '@/lib/server/study/review/repository';
import { invalidInput, readStudyBody, studyJson, studyReviewRoute } from '@/lib/server/study/route';
import { assertSpace } from '@/lib/server/study/wrongbook/repository';
import { parseDailyMinutes } from '@/lib/study/review/contracts';

export const runtime = 'nodejs';

const SPACE_ID = /^[\w-]{1,64}$/;

export function PUT(req: Request) {
  return studyReviewRoute(req, async (ownerId, db, headers) => {
    const body = await readStudyBody(req);
    if (!body) return invalidInput('body', headers);
    if (typeof body.spaceId !== 'string' || !SPACE_ID.test(body.spaceId)) {
      return invalidInput('spaceId', headers);
    }
    const minutes = parseDailyMinutes(body.dailyMinutes);
    if (minutes === null) return invalidInput('dailyMinutes', headers);
    if (!Number.isInteger(body.revision) || (body.revision as number) < 0) {
      return invalidInput('revision', headers);
    }
    await assertSpace(db, ownerId, body.spaceId);
    const settings = await putReviewSettings(
      db,
      ownerId,
      body.spaceId,
      minutes,
      body.revision as number,
    );
    return studyJson({ settings }, 200, headers);
  });
}
