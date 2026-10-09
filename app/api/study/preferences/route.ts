/**
 * Explicit preferences and goals (learning plan B06).
 *
 * GET: all preferences, plus the values never to suggest again (deleted or
 * declined). PUT { key, value, spaceId?, origin?, evidence?,
 * baseRevision? }: set one (global when spaceId is null). `origin` is
 * `settings` (Memory page) or `confirmed_prompt` (the student confirmed a
 * suggestion in a chat); nothing writes preferences on its own.
 * DELETE ?key=&spaceId=: remove one; its value is never suggested again.
 */
import {
  deletePreference,
  listPreferences,
  listSuppressions,
  putPreference,
} from '@/lib/server/study/memory/repository';
import { invalidInput, readStudyBody, studyJson, studyMemoryRoute } from '@/lib/server/study/route';
import { isPreferenceKey, parseEvidence, parsePreferenceValue } from '@/lib/study/memory/contracts';
import { isContentId } from '@/lib/study/spaces/contracts';

export const runtime = 'nodejs';

function spaceParam(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === '') return null;
  return typeof value === 'string' && isContentId(value) ? value : undefined;
}

export function GET(req: Request) {
  return studyMemoryRoute(req, async (ownerId, db, headers) => {
    const preferences = await listPreferences(db, ownerId);
    const suppressed = await listSuppressions(db, ownerId, ['preference', 'suggestion']);
    return studyJson(
      { preferences, suppressedSuggestions: [...new Set(suppressed.map((item) => item.key))] },
      200,
      headers,
    );
  });
}

export function PUT(req: Request) {
  return studyMemoryRoute(req, async (ownerId, db, headers) => {
    const body = await readStudyBody(req);
    if (!body) return invalidInput('body', headers);
    if (!isPreferenceKey(body.key)) return invalidInput('key', headers);
    const value = parsePreferenceValue(body.key, body.value);
    if (!value) return invalidInput('value', headers);
    const spaceId = spaceParam(body.spaceId);
    if (spaceId === undefined) return invalidInput('spaceId', headers);
    const origin = body.origin ?? 'settings';
    if (origin !== 'settings' && origin !== 'confirmed_prompt') {
      return invalidInput('origin', headers);
    }
    const evidence = parseEvidence(body.evidence);
    if (evidence === undefined) return invalidInput('evidence', headers);
    const baseRevision = body.baseRevision;
    if (
      baseRevision !== undefined &&
      (typeof baseRevision !== 'number' || !Number.isInteger(baseRevision) || baseRevision < 0)
    ) {
      return invalidInput('baseRevision', headers);
    }
    const preference = await putPreference(db, ownerId, {
      key: body.key,
      value,
      spaceId,
      origin,
      evidence: origin === 'confirmed_prompt' ? evidence : null,
      baseRevision: baseRevision as number | undefined,
    });
    return studyJson({ preference }, 200, headers);
  });
}

export function DELETE(req: Request) {
  return studyMemoryRoute(req, async (ownerId, db, headers) => {
    const url = new URL(req.url);
    const key = url.searchParams.get('key');
    if (!isPreferenceKey(key)) return invalidInput('key', headers);
    const spaceId = spaceParam(url.searchParams.get('spaceId'));
    if (spaceId === undefined) return invalidInput('spaceId', headers);
    await deletePreference(db, ownerId, key, spaceId);
    return studyJson({ ok: true }, 200, headers);
  });
}
