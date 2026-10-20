/**
 * Explanations of a wrong question on request (learning plan B13).
 *
 * - GET `?spaceId=&itemId=` — the subject's explanations (or one item's),
 *   newest first, without their content.
 * - POST `{ itemId, format: 'text' | 'whiteboard' | 'interactive' | 'course',
 *   language?, consent: true, fresh?, requirement?, media?, idempotencyKey }`
 *   — ask for one. No model is called here: the page then runs it (`/run`),
 *   or, for a course, hands it to course generation. The same inputs return
 *   the saved explanation (`reused: true`) unless `fresh`. 201 with
 *   `{ explanation, reused }`.
 */
import {
  createExplanation,
  isExplanationLanguage,
  listExplanations,
} from '@/lib/server/study/explanations/service';
import {
  invalidInput,
  readStudyBody,
  studyExplanationsRoute,
  studyJson,
} from '@/lib/server/study/route';
import { isRequestKey } from '@/lib/study/assessments/contracts';
import {
  EXPLANATION_LIMITS,
  isExplanationFormat,
  parseCourseMedia,
} from '@/lib/study/explanations/contracts';
import { isStudyId } from '@/lib/study/spaces/contracts';
import { isWrongItemId } from '@/lib/study/wrongbook/contracts';

export const runtime = 'nodejs';

export function GET(req: Request) {
  return studyExplanationsRoute(req, async (ownerId, db, headers) => {
    const url = new URL(req.url);
    const spaceId = url.searchParams.get('spaceId');
    const itemId = url.searchParams.get('itemId');
    if (!isStudyId(spaceId)) return invalidInput('spaceId', headers);
    if (itemId !== null && !isWrongItemId(itemId)) return invalidInput('itemId', headers);
    const explanations = await listExplanations(db, ownerId, {
      spaceId,
      ...(itemId ? { itemId } : {}),
    });
    return studyJson({ explanations }, 200, headers);
  });
}

export function POST(req: Request) {
  return studyExplanationsRoute(req, async (ownerId, db, headers) => {
    const body = await readStudyBody(req);
    if (!body) return invalidInput('body', headers);
    if (!isRequestKey(body.idempotencyKey)) return invalidInput('idempotencyKey', headers);
    if (!isWrongItemId(body.itemId)) return invalidInput('itemId', headers);
    if (!isExplanationFormat(body.format)) return invalidInput('format', headers);
    const language = body.language === undefined ? 'zh-CN' : body.language;
    if (!isExplanationLanguage(language)) return invalidInput('language', headers);
    if (body.fresh !== undefined && typeof body.fresh !== 'boolean') {
      return invalidInput('fresh', headers);
    }
    const media = parseCourseMedia(body.media);
    if (!media) return invalidInput('media', headers);
    const requirement = body.requirement ?? null;
    if (
      requirement !== null &&
      (typeof requirement !== 'string' ||
        requirement.length > EXPLANATION_LIMITS.requirementChars * 2)
    ) {
      return invalidInput('requirement', headers);
    }
    const course = body.format === 'course';
    const result = await createExplanation(db, ownerId, {
      itemId: body.itemId,
      format: body.format,
      language,
      consent: body.consent === true,
      fresh: body.fresh === true,
      idempotencyKey: body.idempotencyKey,
      requirement:
        course && typeof requirement === 'string' && requirement.trim() ? requirement : null,
      media: course ? media : { image: false, tts: false, video: false },
    });
    return studyJson(result, 201, headers);
  });
}
