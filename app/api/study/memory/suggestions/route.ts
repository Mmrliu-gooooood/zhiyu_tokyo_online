/**
 * POST { key, value }: the student declined a preference suggestion in a
 * chat; that value is not suggested again.
 */
import { suppress } from '@/lib/server/study/memory/repository';
import { invalidInput, readStudyBody, studyJson, studyMemoryRoute } from '@/lib/server/study/route';
import {
  isPreferenceKey,
  parsePreferenceValue,
  preferenceSuppressionKey,
} from '@/lib/study/memory/contracts';

export const runtime = 'nodejs';

export function POST(req: Request) {
  return studyMemoryRoute(req, async (ownerId, db, headers) => {
    const body = await readStudyBody(req);
    if (!body) return invalidInput('body', headers);
    if (!isPreferenceKey(body.key) || body.key === 'learning_goal') {
      return invalidInput('key', headers);
    }
    const value = parsePreferenceValue(body.key, body.value);
    if (!value) return invalidInput('value', headers);
    await suppress(
      db,
      ownerId,
      'suggestion',
      [preferenceSuppressionKey(body.key, value)],
      'dismissed',
    );
    return studyJson({ ok: true }, 200, headers);
  });
}
