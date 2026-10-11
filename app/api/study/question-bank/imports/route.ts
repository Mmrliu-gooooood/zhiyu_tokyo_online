/**
 * POST { spaceId, document }: validate an import file (JSON) question by
 * question and mark duplicates; writes nothing.
 * POST { spaceId, commit: true, questions, stageId? }: add the (possibly
 * edited) valid questions; invalid ones and duplicates are skipped and
 * reported. Repeating a commit adds nothing new.
 */
import { commitImport, previewImport } from '@/lib/server/study/questions/service';
import { invalidInput, readStudyBody, studyExamsRoute, studyJson } from '@/lib/server/study/route';
import { QUESTION_LIMITS } from '@/lib/study/questions/contracts';
import { isContentId } from '@/lib/study/spaces/contracts';

export const runtime = 'nodejs';

export function POST(req: Request) {
  return studyExamsRoute(req, async (ownerId, db, headers) => {
    const body = await readStudyBody(req, QUESTION_LIMITS.importBytes);
    if (!body) return invalidInput('body', headers);
    if (!isContentId(body.spaceId)) return invalidInput('spaceId', headers);
    if (body.commit === true) {
      if (!Array.isArray(body.questions)) return invalidInput('questions', headers);
      const stageId = body.stageId ?? null;
      if (stageId !== null && !isContentId(stageId)) return invalidInput('stageId', headers);
      const result = await commitImport(
        db,
        ownerId,
        body.spaceId,
        body.questions,
        stageId as string | null,
      );
      return studyJson(result, 200, headers);
    }
    if (body.document === undefined) return invalidInput('document', headers);
    const preview = await previewImport(db, ownerId, body.spaceId, body.document);
    return studyJson(preview, 200, headers);
  });
}
