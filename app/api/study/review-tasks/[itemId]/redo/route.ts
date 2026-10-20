/**
 * POST { idempotencyKey } — a one-question practice paper with the wrong
 * item's question-bank question as it is now (learning plan B12). Its answer
 * joins the item's history as practice (the question was seen before), never
 * as an independent check. Only bank questions can be redone this way: 409
 * STUDY_REVIEW_REDO_UNAVAILABLE otherwise. Responds with `{ paperId, created }`.
 */
import { startRedo } from '@/lib/server/study/review/service';
import {
  invalidInput,
  isStudyExamsEnabled,
  readStudyBody,
  studyJson,
  studyReviewRoute,
} from '@/lib/server/study/route';
import { StudyError } from '@/lib/server/study/spaces/repository';
import { assertItemVisible } from '@/lib/server/study/wrongbook/service';
import { isWrongItemId } from '@/lib/study/wrongbook/contracts';

export const runtime = 'nodejs';

type Context = { params: Promise<{ itemId: string }> };

const KEY = /^[\w-]{8,100}$/;

export function POST(req: Request, context: Context) {
  return studyReviewRoute(req, async (ownerId, db, headers) => {
    const { itemId } = await context.params;
    if (!isWrongItemId(itemId)) throw new StudyError('STUDY_WRONG_ITEM_NOT_FOUND');
    if (!isStudyExamsEnabled()) {
      throw new StudyError('STUDY_REVIEW_REDO_UNAVAILABLE', { reason: 'papers_off' });
    }
    const body = await readStudyBody(req);
    if (!body) return invalidInput('body', headers);
    if (typeof body.idempotencyKey !== 'string' || !KEY.test(body.idempotencyKey)) {
      return invalidInput('idempotencyKey', headers);
    }
    await assertItemVisible(db, ownerId, itemId);
    const paper = await startRedo(db, ownerId, itemId, body.idempotencyKey);
    return studyJson(paper, paper.created ? 201 : 200, headers);
  });
}
