/**
 * GET: one space with its courses and progress. PATCH: edit fields or
 * archive/restore, guarded by `revision`. DELETE: remove the space and its
 * course links (the courses stay) and retire its after-class chats.
 */
import { isStudyId, parseStudySpacePatch } from '@/lib/study/spaces/contracts';
import { invalidInput, readStudyBody, studyJson, studyRoute } from '@/lib/server/study/route';
import { deleteStudySpaceWithChats } from '@/lib/server/study/companion/service';
import { StudyError, getStudySpace, updateStudySpace } from '@/lib/server/study/spaces/repository';

export const runtime = 'nodejs';

type Context = { params: Promise<{ spaceId: string }> };

export function GET(req: Request, context: Context) {
  return studyRoute(req, async (ownerId, db, headers) => {
    const { spaceId } = await context.params;
    if (!isStudyId(spaceId)) throw new StudyError('STUDY_SPACE_NOT_FOUND');
    return studyJson({ space: await getStudySpace(db, ownerId, spaceId) }, 200, headers);
  });
}

export function PATCH(req: Request, context: Context) {
  return studyRoute(req, async (ownerId, db, headers) => {
    const { spaceId } = await context.params;
    if (!isStudyId(spaceId)) throw new StudyError('STUDY_SPACE_NOT_FOUND');
    const body = await readStudyBody(req);
    if (!body) return invalidInput('body', headers);
    const { revision, ...fields } = body;
    if (!Number.isInteger(revision) || (revision as number) < 1) {
      return invalidInput('revision', headers);
    }
    const parsed = parseStudySpacePatch(fields);
    if (!parsed.ok) return invalidInput(parsed.field, headers);
    const space = await updateStudySpace(db, ownerId, spaceId, parsed.value, revision as number);
    return studyJson({ space }, 200, headers);
  });
}

export function DELETE(req: Request, context: Context) {
  return studyRoute(req, async (ownerId, db, headers) => {
    const { spaceId } = await context.params;
    if (!isStudyId(spaceId)) throw new StudyError('STUDY_SPACE_NOT_FOUND');
    await deleteStudySpaceWithChats(db, ownerId, spaceId);
    return studyJson({ deleted: true }, 200, headers);
  });
}
