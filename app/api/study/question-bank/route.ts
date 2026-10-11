/**
 * GET ?spaceId&type&verification&state&conceptId&stageId&q&offset: one page of
 * a subject's question bank (the owner's own questions, answers included).
 * POST { spaceId, question, verified?, stageId? }: add one question written in
 * the editor.
 */
import { listQuestions, requireQuestionSpace } from '@/lib/server/study/questions/repository';
import { createManualQuestion } from '@/lib/server/study/questions/service';
import { invalidInput, readStudyBody, studyExamsRoute, studyJson } from '@/lib/server/study/route';
import {
  QUESTION_LIMITS,
  QUESTION_TYPES,
  type QuestionType,
} from '@/lib/study/questions/contracts';
import { isContentId } from '@/lib/study/spaces/contracts';

export const runtime = 'nodejs';

export function GET(req: Request) {
  return studyExamsRoute(req, async (ownerId, db, headers) => {
    const url = new URL(req.url);
    const spaceId = url.searchParams.get('spaceId');
    if (!isContentId(spaceId)) return invalidInput('spaceId', headers);
    const type = url.searchParams.get('type');
    if (type && !(QUESTION_TYPES as readonly string[]).includes(type)) {
      return invalidInput('type', headers);
    }
    const verification = url.searchParams.get('verification');
    if (verification && verification !== 'verified' && verification !== 'unverified') {
      return invalidInput('verification', headers);
    }
    const state = url.searchParams.get('state');
    if (state && state !== 'gradable' && state !== 'drafts') return invalidInput('state', headers);
    const conceptId = url.searchParams.get('conceptId');
    if (conceptId && !isContentId(conceptId, 64)) return invalidInput('conceptId', headers);
    const stageId = url.searchParams.get('stageId');
    if (stageId && !isContentId(stageId)) return invalidInput('stageId', headers);
    const query = url.searchParams.get('q')?.trim().slice(0, 100) || undefined;
    const offset = Number(url.searchParams.get('offset') ?? 0);
    if (!Number.isInteger(offset) || offset < 0 || offset > 10_000) {
      return invalidInput('offset', headers);
    }
    await requireQuestionSpace(db, ownerId, spaceId, { writable: false });
    const result = await listQuestions(db, ownerId, spaceId, {
      type: (type as QuestionType) || undefined,
      verification: (verification as 'verified' | 'unverified') || undefined,
      state: (state as 'gradable' | 'drafts') || undefined,
      conceptId: conceptId || undefined,
      stageId: stageId || undefined,
      query,
      offset,
    });
    return studyJson(result, 200, headers);
  });
}

export function POST(req: Request) {
  return studyExamsRoute(req, async (ownerId, db, headers) => {
    const body = await readStudyBody(req, QUESTION_LIMITS.editBytes);
    if (!body) return invalidInput('body', headers);
    if (!isContentId(body.spaceId)) return invalidInput('spaceId', headers);
    if (body.verified !== undefined && typeof body.verified !== 'boolean') {
      return invalidInput('verified', headers);
    }
    const stageId = body.stageId ?? null;
    if (stageId !== null && !isContentId(stageId)) return invalidInput('stageId', headers);
    const result = await createManualQuestion(db, ownerId, {
      spaceId: body.spaceId,
      question: body.question,
      verified: body.verified === true,
      stageId: stageId as string | null,
    });
    return studyJson({ question: result.question }, result.created ? 201 : 200, headers);
  });
}
