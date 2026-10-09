/**
 * POST { preferences, facts, records, rawQuizAttempts }: clear parts of
 * Memory. Cleared preferences and records stay suppressed (never suggested
 * or projected again). The classroom quiz attempts themselves — answers and
 * scores — are deleted only when `rawQuizAttempts` is explicitly true.
 */
import { clearMemory } from '@/lib/server/study/memory/repository';
import { invalidInput, readStudyBody, studyJson, studyMemoryRoute } from '@/lib/server/study/route';

export const runtime = 'nodejs';

const FIELDS = ['preferences', 'facts', 'records', 'rawQuizAttempts'] as const;

export function POST(req: Request) {
  return studyMemoryRoute(req, async (ownerId, db, headers) => {
    const body = await readStudyBody(req);
    if (!body) return invalidInput('body', headers);
    for (const field of FIELDS) {
      if (body[field] !== undefined && typeof body[field] !== 'boolean') {
        return invalidInput(field, headers);
      }
    }
    const options = {
      preferences: body.preferences === true,
      facts: body.facts === true,
      records: body.records === true,
      rawQuizAttempts: body.rawQuizAttempts === true,
    };
    if (!Object.values(options).some(Boolean)) return invalidInput('body', headers);
    const cleared = await clearMemory(db, ownerId, options);
    return studyJson({ cleared }, 200, headers);
  });
}
