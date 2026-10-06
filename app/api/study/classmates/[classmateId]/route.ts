/**
 * GET: one classmate. PATCH: edit fields, authorised materials, or
 * archive/restore, guarded by `revision`. Every saved change becomes a new
 * revision; classrooms made earlier keep the revision they copied.
 */
import { isClassmateId, parseClassmatePatch } from '@/lib/study/classmates/contracts';
import {
  invalidInput,
  readStudyBody,
  studyClassmatesRoute,
  studyJson,
} from '@/lib/server/study/route';
import { getClassmate, updateClassmate } from '@/lib/server/study/classmates/repository';
import { StudyError } from '@/lib/server/study/spaces/repository';

export const runtime = 'nodejs';

type Context = { params: Promise<{ classmateId: string }> };

export function GET(req: Request, context: Context) {
  return studyClassmatesRoute(req, async (ownerId, db, headers) => {
    const { classmateId } = await context.params;
    if (!isClassmateId(classmateId)) throw new StudyError('STUDY_CLASSMATE_NOT_FOUND');
    return studyJson({ classmate: await getClassmate(db, ownerId, classmateId) }, 200, headers);
  });
}

export function PATCH(req: Request, context: Context) {
  return studyClassmatesRoute(req, async (ownerId, db, headers) => {
    const { classmateId } = await context.params;
    if (!isClassmateId(classmateId)) throw new StudyError('STUDY_CLASSMATE_NOT_FOUND');
    const body = await readStudyBody(req);
    if (!body) return invalidInput('body', headers);
    const { revision, ...fields } = body;
    if (!Number.isInteger(revision) || (revision as number) < 1) {
      return invalidInput('revision', headers);
    }
    const parsed = parseClassmatePatch(fields);
    if (!parsed.ok) return invalidInput(parsed.field, headers);
    const classmate = await updateClassmate(
      db,
      ownerId,
      classmateId,
      parsed.value,
      revision as number,
    );
    return studyJson({ classmate }, 200, headers);
  });
}
