/**
 * Shared guard for the study APIs (learning plan B01).
 *
 * - The server capability (`ZHIYU_STUDY_SPACES_ENABLED` plus the cloud course
 *   library) gates the whole family; off answers a plain 404.
 * - The owner comes from the verified session (withRequestOwnerId, which also
 *   checks the request origin). Study data belongs to accounts only: an
 *   anonymous device owner is refused, so nothing is written to a shared
 *   anonymous pile.
 * - Queries run owner-bound on the persistence pool (app_web when hosted).
 * - Responses are never cached; errors carry fixed codes only.
 */
import { parseOwnerUserId } from '@/lib/auth/principal';
import { isCloudCourseLibraryEnabled } from '@/lib/config/feature-flags';
import { createLogger } from '@/lib/logger';
import { getOwnerBoundStageAccessDb } from '@/lib/server/stage-access';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import { StudyError, type StudyDb } from '@/lib/server/study/spaces/repository';
import { LearningTaskError } from '@/lib/server/learning-tasks/contracts';
import { isStudyMaterialsFlagOn } from '@/lib/server/study/flags';

const log = createLogger('StudyRoute');

export const MAX_STUDY_BODY = 16_384;

/** Server-only runtime gate; needs accounts v22 (hosted) before it is turned on. */
export function isStudySpacesEnabled(): boolean {
  const flag = process.env.ZHIYU_STUDY_SPACES_ENABLED;
  return (flag === '1' || flag === 'true') && isCloudCourseLibraryEnabled();
}

export function studyJson(body: unknown, status: number, headers: Headers): Response {
  return Response.json(body, { status, headers });
}

export async function studyRoute(
  req: Request,
  handler: (ownerId: string, db: StudyDb, headers: Headers) => Promise<Response>,
): Promise<Response> {
  if (!isStudySpacesEnabled()) {
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
  return withRequestOwnerId(req, async (ownerId, headers) => {
    headers.set('Cache-Control', 'private, no-store');
    if (!parseOwnerUserId(ownerId)) {
      return studyJson({ error: 'STUDY_ACCOUNT_REQUIRED' }, 401, headers);
    }
    try {
      const db = (await getOwnerBoundStageAccessDb(ownerId)) as StudyDb;
      return await handler(ownerId, db, headers);
    } catch (error) {
      if (error instanceof StudyError) {
        return studyJson({ error: error.code, ...error.details }, error.status, headers);
      }
      if (error instanceof LearningTaskError) {
        return studyJson({ error: error.code }, error.httpStatus, headers);
      }
      log.error('study request failed', {
        name: error instanceof Error ? error.name : typeof error,
        code:
          error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined,
      });
      return studyJson({ error: 'STUDY_UNAVAILABLE' }, 503, headers);
    }
  });
}

/** B02 material library gate: needs study spaces plus ZHIYU_STUDY_MATERIALS_ENABLED. */
export function isStudyMaterialsEnabled(): boolean {
  return isStudyMaterialsFlagOn() && isStudySpacesEnabled();
}

/** studyRoute for the material library and learning-task APIs. */
export function studyMaterialsRoute(
  req: Request,
  handler: (ownerId: string, db: StudyDb, headers: Headers) => Promise<Response>,
): Promise<Response> {
  if (!isStudyMaterialsEnabled()) {
    return Promise.resolve(
      new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } }),
    );
  }
  return studyRoute(req, handler);
}

/** A small JSON object body, or undefined when absent, oversized or malformed. */
export async function readStudyBody(req: Request): Promise<Record<string, unknown> | undefined> {
  if (Number(req.headers.get('content-length') ?? 0) > MAX_STUDY_BODY) return undefined;
  const raw = await req.text();
  if (raw.length > MAX_STUDY_BODY) return undefined;
  try {
    const value: unknown = raw ? JSON.parse(raw) : {};
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function invalidInput(field: string, headers: Headers): Response {
  return studyJson({ error: 'STUDY_INVALID_INPUT', field }, 400, headers);
}
