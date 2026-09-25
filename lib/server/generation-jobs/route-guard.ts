import { hostedAuthGate } from '@/lib/auth/api';
import { createOwnerBoundQueryable } from '@/lib/db/request-queryable';
import { resolveRequestOwnerIdAsync } from '@/lib/server/agent-runtime/owner';
import {
  acquireForegroundGenerationRoot,
  FOREGROUND_GENERATION_ROOT_HEADER,
  FOREGROUND_GENERATION_SESSION_HEADER,
} from '@/lib/server/heavy-task-admission/foreground-generation';
import { assertGenerationOrigin } from './auth';
import { GenerationJobError } from './contracts';
import { assertClientGenerationAllowed } from './ownership';
import { backgroundGenerationEnabled, getGenerationRequestPool } from './runtime';

/** Runs before provider resolution; caller-supplied producer fields grant nothing. */
export async function guardClientGeneration(
  req: Request,
  options: { allowBackgroundIndependentMedia?: boolean } = {},
): Promise<Response | null> {
  const denied = await hostedAuthGate(req);
  if (denied) return denied;
  const enabled = backgroundGenerationEnabled();
  if (!enabled && !process.env.DATABASE_URL) return null;
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  try {
    if (enabled) assertGenerationOrigin(req);
    const body: unknown = await req.clone().json();
    const stageId =
      body && typeof body === 'object' && 'stageId' in body ? body.stageId : undefined;
    const foregroundStageId = req.headers.get(FOREGROUND_GENERATION_ROOT_HEADER)?.trim();
    const foregroundSessionId = req.headers.get(FOREGROUND_GENERATION_SESSION_HEADER)?.trim();
    if (foregroundStageId && stageId !== foregroundStageId) {
      throw new GenerationJobError('FOREGROUND_GENERATION_ROOT_MISMATCH', 400);
    }
    if (foregroundStageId && !foregroundSessionId) {
      throw new GenerationJobError('FOREGROUND_GENERATION_SESSION_REQUIRED', 400);
    }
    let owner: string | undefined;
    if (typeof stageId === 'string' && stageId) {
      owner = await resolveRequestOwnerIdAsync(req, headers);
      const queryable = createOwnerBoundQueryable(getGenerationRequestPool(), owner);
      const existing = await queryable.query('SELECT 1 FROM document_stages WHERE id=$1', [
        stageId,
      ]);
      if (existing.rows.length > 0) {
        await assertClientGenerationAllowed(queryable, stageId, owner);
      } else if (!enabled && !foregroundStageId) {
        return null;
      }
    }
    if (!enabled && foregroundStageId) {
      owner ??= await resolveRequestOwnerIdAsync(req, headers);
      const admission = await acquireForegroundGenerationRoot(
        owner,
        foregroundStageId,
        foregroundSessionId!,
      );
      if (!admission.allowed) {
        const personal = admission.reason === 'personal_limit';
        const unavailable = admission.reason === 'unavailable';
        const inactive = admission.reason === 'account_inactive';
        return Response.json(
          {
            success: false,
            errorCode: inactive
              ? 'ACCOUNT_INACTIVE'
              : unavailable
                ? 'HEAVY_TASK_ADMISSION_UNAVAILABLE'
                : personal
                  ? 'HEAVY_TASK_PERSONAL_CAPACITY_LIMIT'
                  : 'HEAVY_TASK_SITE_CAPACITY_LIMIT',
            error: admission.reason,
          },
          { status: inactive ? 403 : unavailable ? 503 : personal ? 429 : 503, headers },
        );
      }
    }
    // Legacy calls cannot compete for the worker deployment's credentials.
    // Normal creation must enter through the versioned, durable job protocol.
    if (enabled && !options.allowBackgroundIndependentMedia) {
      throw new GenerationJobError('BACKGROUND_GENERATION_REQUIRED', 409);
    }
    return null;
  } catch (error) {
    if (error instanceof SyntaxError) return null; // Preserve each route's input validation.
    const known = error instanceof GenerationJobError;
    return Response.json(
      {
        success: false,
        errorCode: known ? error.code : 'GENERATION_UNAVAILABLE',
        error: known ? error.code : 'Generation service unavailable',
      },
      { status: known ? error.httpStatus : 503, headers },
    );
  }
}
