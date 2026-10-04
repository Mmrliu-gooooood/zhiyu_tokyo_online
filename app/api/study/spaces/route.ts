/** GET: the owner's study spaces. POST: create one. */
import { parseStudySpaceInput } from '@/lib/study/spaces/contracts';
import { invalidInput, readStudyBody, studyJson, studyRoute } from '@/lib/server/study/route';
import { createStudySpace, listStudySpaces } from '@/lib/server/study/spaces/repository';

export const runtime = 'nodejs';

export function GET(req: Request) {
  return studyRoute(req, async (ownerId, db, headers) =>
    studyJson({ spaces: await listStudySpaces(db, ownerId) }, 200, headers),
  );
}

export function POST(req: Request) {
  return studyRoute(req, async (ownerId, db, headers) => {
    const parsed = parseStudySpaceInput(await readStudyBody(req));
    if (!parsed.ok) return invalidInput(parsed.field, headers);
    return studyJson({ space: await createStudySpace(db, ownerId, parsed.value) }, 201, headers);
  });
}
