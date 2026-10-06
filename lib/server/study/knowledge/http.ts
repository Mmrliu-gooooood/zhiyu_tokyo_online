/** Request parsing shared by the study QA routes (learning plan B03). */
import { STUDY_QA_LIMITS } from '@/lib/study/knowledge/contracts';
import { isStudyId } from '@/lib/study/spaces/contracts';

export const MAX_QA_BODY = 32_768;

/** A JSON object body up to MAX_QA_BODY, or undefined. */
export async function readQaBody(req: Request): Promise<Record<string, unknown> | undefined> {
  if (Number(req.headers.get('content-length') ?? 0) > MAX_QA_BODY) return undefined;
  const raw = await req.text();
  if (raw.length > MAX_QA_BODY) return undefined;
  try {
    const value: unknown = raw ? JSON.parse(raw) : {};
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function parseQuestion(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const question = value.replace(/\s+/g, ' ').trim();
  return question.length > 0 && question.length <= STUDY_QA_LIMITS.maxQuestionChars
    ? question
    : null;
}

/** Optional `versionIds` pin: distinct study ids, at most maxPinnedVersions. */
export function parsePinnedVersions(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > STUDY_QA_LIMITS.maxPinnedVersions) return null;
  if (!value.every((id) => isStudyId(id))) return null;
  return [...new Set(value as string[])];
}
