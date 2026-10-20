/**
 * POST { kind, until?, revision, timezone? } — one review action on a wrong
 * item's card (learning plan B12): `done` (reviewed it), `postpone` to
 * `until` (YYYY-MM-DD, tomorrow to a year ahead), `skip`, or `clear` a
 * postponement or skip. A stale revision is 409 with the current card.
 * Responds with `{ revision, actions }`.
 */
import { applyReviewAction } from '@/lib/server/study/review/service';
import { invalidInput, readStudyBody, studyJson, studyReviewRoute } from '@/lib/server/study/route';
import { StudyError } from '@/lib/server/study/spaces/repository';
import { assertItemVisible } from '@/lib/server/study/wrongbook/service';
import { REVIEW_ACTION_KINDS, type ReviewActionKind } from '@/lib/study/review/contracts';
import { isWrongItemId } from '@/lib/study/wrongbook/contracts';

export const runtime = 'nodejs';

type Context = { params: Promise<{ itemId: string }> };

const TIME_ZONE = /^[A-Za-z0-9_+\-/]{1,64}$/;

export function POST(req: Request, context: Context) {
  return studyReviewRoute(req, async (ownerId, db, headers) => {
    const { itemId } = await context.params;
    if (!isWrongItemId(itemId)) throw new StudyError('STUDY_WRONG_ITEM_NOT_FOUND');
    const body = await readStudyBody(req);
    if (!body) return invalidInput('body', headers);
    const kind = body.kind;
    if (typeof kind !== 'string' || !(REVIEW_ACTION_KINDS as readonly string[]).includes(kind)) {
      return invalidInput('kind', headers);
    }
    if (!Number.isInteger(body.revision) || (body.revision as number) < 1) {
      return invalidInput('revision', headers);
    }
    if (kind === 'postpone' ? typeof body.until !== 'string' : body.until !== undefined) {
      return invalidInput('until', headers);
    }
    const timezone = body.timezone;
    if (timezone !== undefined && (typeof timezone !== 'string' || !TIME_ZONE.test(timezone))) {
      return invalidInput('timezone', headers);
    }
    await assertItemVisible(db, ownerId, itemId);
    const result = await applyReviewAction(db, ownerId, itemId, {
      kind: kind as ReviewActionKind,
      revision: body.revision as number,
      ...(kind === 'postpone' ? { until: body.until as string } : {}),
      timezone: (timezone as string | undefined) ?? null,
    });
    return studyJson(result, 200, headers);
  });
}
