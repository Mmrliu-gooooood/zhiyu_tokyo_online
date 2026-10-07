/** GET: the owner's classmates (`?status=active|archived`). POST: create one. */
import {
  CLASSMATE_STATUSES,
  parseClassmateInput,
  type ClassmateStatus,
} from '@/lib/study/classmates/contracts';
import {
  invalidInput,
  readStudyBody,
  studyClassmatesRoute,
  studyJson,
} from '@/lib/server/study/route';
import { createClassmate, listClassmates } from '@/lib/server/study/classmates/repository';
import { assertClassmateModelPolicy } from '@/lib/server/study/companion/model-policy';

export const runtime = 'nodejs';

export function GET(req: Request) {
  return studyClassmatesRoute(req, async (ownerId, db, headers) => {
    const status = new URL(req.url).searchParams.get('status');
    if (status !== null && !(CLASSMATE_STATUSES as readonly string[]).includes(status)) {
      return invalidInput('status', headers);
    }
    const classmates = await listClassmates(
      db,
      ownerId,
      status ? { status: status as ClassmateStatus } : {},
    );
    return studyJson({ classmates }, 200, headers);
  });
}

export function POST(req: Request) {
  return studyClassmatesRoute(req, async (ownerId, db, headers) => {
    const parsed = parseClassmateInput(await readStudyBody(req));
    if (!parsed.ok) return invalidInput(parsed.field, headers);
    if (parsed.value.modelPolicy)
      await assertClassmateModelPolicy(ownerId, parsed.value.modelPolicy);
    return studyJson({ classmate: await createClassmate(db, ownerId, parsed.value) }, 201, headers);
  });
}
