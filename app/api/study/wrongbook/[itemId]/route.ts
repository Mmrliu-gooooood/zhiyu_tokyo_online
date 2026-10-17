/**
 * One wrong item (learning plan B10).
 *
 * GET   — the item with every answer to it (newest first) and where "look
 *         back" can lead, checked now (a changed classroom page is not
 *         offered as the original).
 * PATCH { revision, reviewState?, archived? } — mark for review / archive;
 *         a stale revision is 409 with the current state.
 */
import {
  invalidInput,
  readStudyBody,
  studyJson,
  studyWrongbookRoute,
} from '@/lib/server/study/route';
import { StudyError } from '@/lib/server/study/spaces/repository';
import { updateItemState } from '@/lib/server/study/wrongbook/repository';
import { assertItemVisible, getWrongItem } from '@/lib/server/study/wrongbook/service';
import { isWrongItemId } from '@/lib/study/wrongbook/contracts';

export const runtime = 'nodejs';

type Context = { params: Promise<{ itemId: string }> };

export function GET(req: Request, context: Context) {
  return studyWrongbookRoute(req, async (ownerId, db, headers) => {
    const { itemId } = await context.params;
    if (!isWrongItemId(itemId)) throw new StudyError('STUDY_WRONG_ITEM_NOT_FOUND');
    return studyJson({ item: await getWrongItem(db, ownerId, itemId) }, 200, headers);
  });
}

export function PATCH(req: Request, context: Context) {
  return studyWrongbookRoute(req, async (ownerId, db, headers) => {
    const { itemId } = await context.params;
    if (!isWrongItemId(itemId)) throw new StudyError('STUDY_WRONG_ITEM_NOT_FOUND');
    const body = await readStudyBody(req);
    if (!body) return invalidInput('body', headers);
    if (!Number.isInteger(body.revision) || (body.revision as number) < 1) {
      return invalidInput('revision', headers);
    }
    const reviewState = body.reviewState;
    if (reviewState !== undefined && reviewState !== 'none' && reviewState !== 'to_review') {
      return invalidInput('reviewState', headers);
    }
    if (body.archived !== undefined && typeof body.archived !== 'boolean') {
      return invalidInput('archived', headers);
    }
    if (reviewState === undefined && body.archived === undefined) {
      return invalidInput('body', headers);
    }
    // The item must still be visible (its course still in the space).
    await assertItemVisible(db, ownerId, itemId);
    const state = await updateItemState(db, ownerId, itemId, body.revision as number, {
      ...(reviewState !== undefined ? { reviewState } : {}),
      ...(body.archived !== undefined ? { archived: body.archived as boolean } : {}),
    });
    return studyJson(state, 200, headers);
  });
}
