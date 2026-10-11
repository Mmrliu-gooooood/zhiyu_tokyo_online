/**
 * GET ?spaceId: the subject's papers, newest first, with their attempts.
 * POST { blueprint, title, idempotencyKey }: freeze a paper. 201 when new,
 * 200 when the same request was already published, 409 STUDY_EXAM_INSUFFICIENT
 * with the shortfalls when the bank cannot fill it.
 */
import { getPaperSummary, listPapers } from '@/lib/server/study/exams/repository';
import { publishPaper } from '@/lib/server/study/exams/service';
import { requireQuestionSpace } from '@/lib/server/study/questions/repository';
import { invalidInput, readStudyBody, studyExamsRoute, studyJson } from '@/lib/server/study/route';
import { isRequestKey } from '@/lib/study/assessments/contracts';
import { BLUEPRINT_LIMITS, parseBlueprint } from '@/lib/study/questions/blueprint';
import { isContentId } from '@/lib/study/spaces/contracts';

export const runtime = 'nodejs';

export function GET(req: Request) {
  return studyExamsRoute(req, async (ownerId, db, headers) => {
    const spaceId = new URL(req.url).searchParams.get('spaceId');
    if (!isContentId(spaceId)) return invalidInput('spaceId', headers);
    await requireQuestionSpace(db, ownerId, spaceId, { writable: false });
    return studyJson({ papers: await listPapers(db, ownerId, spaceId) }, 200, headers);
  });
}

export function POST(req: Request) {
  return studyExamsRoute(req, async (ownerId, db, headers) => {
    const body = await readStudyBody(req);
    if (!body) return invalidInput('body', headers);
    const parsed = parseBlueprint(body.blueprint);
    if (!parsed.ok) return invalidInput(parsed.field, headers);
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title || title.length > BLUEPRINT_LIMITS.title) return invalidInput('title', headers);
    if (!isRequestKey(body.idempotencyKey)) return invalidInput('idempotencyKey', headers);
    const result = await publishPaper(db, ownerId, {
      blueprint: parsed.blueprint,
      title,
      idempotencyKey: body.idempotencyKey,
    });
    const paper = await getPaperSummary(db, ownerId, result.paperId);
    return studyJson({ paper }, result.created ? 201 : 200, headers);
  });
}
