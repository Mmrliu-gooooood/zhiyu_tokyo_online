/**
 * POST { question, versionIds? } — retrieval only (learning plan B03): the
 * scoped passages with their locations and how each was found. No answer
 * model is called; the query embedding is the only model call, and without it
 * the result is keyword matching and says so (`retrieval: 'lexical'`).
 */
import { isStudyId } from '@/lib/study/spaces/contracts';
import { invalidInput, studyQaRoute } from '@/lib/server/study/route';
import { StudyError } from '@/lib/server/study/spaces/repository';
import { parsePinnedVersions, parseQuestion, readQaBody } from '@/lib/server/study/knowledge/http';
import { searchQuestion } from '@/lib/server/study/knowledge/service';

export const runtime = 'nodejs';

type Context = { params: Promise<{ spaceId: string }> };

export function POST(req: Request, context: Context) {
  return studyQaRoute(req, async (ownerId, db, headers) => {
    const { spaceId } = await context.params;
    if (!isStudyId(spaceId)) throw new StudyError('STUDY_SPACE_NOT_FOUND');
    const body = await readQaBody(req);
    const question = parseQuestion(body?.question);
    if (!question) return invalidInput('question', headers);
    const pinnedVersionIds = parsePinnedVersions(body?.versionIds);
    if (!pinnedVersionIds) return invalidInput('versionIds', headers);
    return searchQuestion(req, db, ownerId, { spaceId, question, pinnedVersionIds }, headers);
  });
}
