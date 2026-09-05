import { resolveRequestOwnerId } from '@/lib/server/agent-runtime/owner';
import { assertGenerationOrigin } from './auth';
import { GenerationJobError } from './contracts';
import { assertClientGenerationAllowed } from './ownership';
import { backgroundGenerationEnabled, getGenerationPool } from './runtime';

/** Runs before provider resolution; caller-supplied producer fields grant nothing. */
export async function guardClientGeneration(req: Request): Promise<Response | null> {
  const enabled = backgroundGenerationEnabled();
  if (!enabled && !process.env.DATABASE_URL) return null;
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  try {
    if (enabled) assertGenerationOrigin(req);
    const body: unknown = await req.clone().json();
    const stageId =
      body && typeof body === 'object' && 'stageId' in body ? body.stageId : undefined;
    if (typeof stageId === 'string' && stageId) {
      if (!enabled) {
        const existing = await getGenerationPool().query(
          'SELECT 1 FROM document_stages WHERE id=$1',
          [stageId],
        );
        if (existing.rowCount === 0) return null;
      }
      const owner = resolveRequestOwnerId(req, headers);
      await assertClientGenerationAllowed(getGenerationPool(), stageId, owner);
    }
    // Legacy calls cannot compete for the worker deployment's credentials.
    // Normal creation must enter through the versioned, durable job protocol.
    if (enabled) throw new GenerationJobError('BACKGROUND_GENERATION_REQUIRED', 409);
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
