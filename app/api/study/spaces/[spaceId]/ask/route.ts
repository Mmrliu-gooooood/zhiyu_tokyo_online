/**
 * GET  — the space's saved answers, newest first (learning plan B03).
 * POST { question, versionIds?, thinkingConfig? } + model-selection headers —
 *      answer from the space's indexed materials with server-approved
 *      citations. One budgeted operation per request; aborting the request
 *      cancels it and nothing is saved.
 */
import { isStudyId } from '@/lib/study/spaces/contracts';
import { invalidInput, studyJson, studyQaRoute } from '@/lib/server/study/route';
import { StudyError } from '@/lib/server/study/spaces/repository';
import { parsePinnedVersions, parseQuestion, readQaBody } from '@/lib/server/study/knowledge/http';
import { listStudyAnswers } from '@/lib/server/study/knowledge/repository';
import { answerQuestion } from '@/lib/server/study/knowledge/service';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Context = { params: Promise<{ spaceId: string }> };

export function GET(req: Request, context: Context) {
  return studyQaRoute(req, async (ownerId, db, headers) => {
    const { spaceId } = await context.params;
    if (!isStudyId(spaceId)) throw new StudyError('STUDY_SPACE_NOT_FOUND');
    const answers = await db.withTransaction(async (tx) => {
      const space = await tx.query('SELECT 1 FROM study_spaces WHERE owner_id=$1 AND id=$2', [
        ownerId,
        spaceId,
      ]);
      if (space.rows.length === 0) throw new StudyError('STUDY_SPACE_NOT_FOUND');
      return listStudyAnswers(tx, ownerId, spaceId);
    });
    return studyJson({ answers }, 200, headers);
  });
}

export function POST(req: Request, context: Context) {
  return studyQaRoute(req, async (ownerId, db, headers) => {
    const { spaceId } = await context.params;
    if (!isStudyId(spaceId)) throw new StudyError('STUDY_SPACE_NOT_FOUND');
    const body = await readQaBody(req);
    const question = parseQuestion(body?.question);
    if (!question) return invalidInput('question', headers);
    const pinnedVersionIds = parsePinnedVersions(body?.versionIds);
    if (!pinnedVersionIds) return invalidInput('versionIds', headers);
    return answerQuestion(req, db, ownerId, { spaceId, question, pinnedVersionIds, body }, headers);
  });
}
