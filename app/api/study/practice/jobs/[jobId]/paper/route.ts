/**
 * POST { title?, idempotencyKey, acceptShort? } — freeze the paper of a
 * completed or stopped AI practice job. A job feeds one paper: asking again
 * returns it. Fewer questions than planned need `acceptShort: true`
 * (409 STUDY_PRACTICE_INCOMPLETE otherwise); a mixed paper whose bank part
 * changed since the job was planned is 409 STUDY_PRACTICE_BANK_CHANGED.
 */
import { getPaperSummary } from '@/lib/server/study/exams/repository';
import { publishPracticeJob } from '@/lib/server/study/practice/service';
import {
  invalidInput,
  readStudyBody,
  studyJson,
  studyPracticeRoute,
} from '@/lib/server/study/route';
import { StudyError } from '@/lib/server/study/spaces/repository';
import { isRequestKey } from '@/lib/study/assessments/contracts';
import { isPracticeJobId } from '@/lib/study/practice/contracts';
import { BLUEPRINT_LIMITS } from '@/lib/study/questions/blueprint';

export const runtime = 'nodejs';

type Context = { params: Promise<{ jobId: string }> };

export function POST(req: Request, context: Context) {
  return studyPracticeRoute(req, async (ownerId, db, headers) => {
    const { jobId } = await context.params;
    if (!isPracticeJobId(jobId)) throw new StudyError('STUDY_PRACTICE_JOB_NOT_FOUND');
    const body = await readStudyBody(req);
    if (!body) return invalidInput('body', headers);
    if (!isRequestKey(body.idempotencyKey)) return invalidInput('idempotencyKey', headers);
    const title = body.title ?? null;
    if (
      title !== null &&
      (typeof title !== 'string' || title.trim().length > BLUEPRINT_LIMITS.title)
    ) {
      return invalidInput('title', headers);
    }
    if (body.acceptShort !== undefined && typeof body.acceptShort !== 'boolean') {
      return invalidInput('acceptShort', headers);
    }
    const result = await publishPracticeJob(db, ownerId, jobId, {
      title: title as string | null,
      idempotencyKey: body.idempotencyKey,
      acceptShort: body.acceptShort === true,
    });
    const paper = await getPaperSummary(db, ownerId, result.paperId);
    return studyJson({ paper }, result.created ? 201 : 200, headers);
  });
}
