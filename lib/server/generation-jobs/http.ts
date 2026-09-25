import { z } from 'zod';
import { AuthError, authJsonResponse } from '@/lib/auth/errors';
import {
  createOwnerBoundQueryable,
  createOwnerBoundTransactionSource,
  type OwnerBoundQueryable,
} from '@/lib/db/request-queryable';
import { assertGenerationOrigin, resolveGenerationOwnerAsync } from './auth';
import { GenerationJobError } from './contracts';
import { assertGenerationRequestReady, getGenerationRequestPool } from './runtime';
import { GenerationJobRepository } from './repository';
import { withProviderQuotaOwner } from './provider-call-context';

export async function readBoundedBody(req: Request, limit = 1_048_576): Promise<Uint8Array> {
  const reader = req.body?.getReader();
  if (!reader) throw new GenerationJobError('INVALID_REQUEST', 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new GenerationJobError('INPUT_TOO_LARGE', 400);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
export async function readGenerationJson(req: Request): Promise<unknown> {
  try {
    return JSON.parse(new TextDecoder().decode(await readBoundedBody(req)));
  } catch (error) {
    if (error instanceof GenerationJobError) throw error;
    throw new GenerationJobError('INVALID_JSON', 400);
  }
}
export function generationResponse(body: unknown, headers: Headers, status = 200): Response {
  headers.set('Cache-Control', 'private, no-store');
  return Response.json(body, { status, headers });
}
export async function withGenerationRequest(
  req: Request,
  handler: (context: {
    ownerId: string;
    headers: Headers;
    repository: GenerationJobRepository;
    queryable: OwnerBoundQueryable;
  }) => Promise<Response>,
  options: { createSession?: boolean; submitting?: boolean } = {},
): Promise<Response> {
  const headers = new Headers({ 'Cache-Control': 'private, no-store' });
  let stage: 'origin' | 'owner' | 'readiness' | 'handler' = 'origin';
  try {
    assertGenerationOrigin(req);
    stage = 'owner';
    const ownerId = await resolveGenerationOwnerAsync(req, headers, options.createSession);
    stage = 'readiness';
    await assertGenerationRequestReady(options.submitting);
    const pool = getGenerationRequestPool();
    stage = 'handler';
    return await withProviderQuotaOwner(ownerId, () =>
      handler({
        ownerId,
        headers,
        repository: new GenerationJobRepository(createOwnerBoundTransactionSource(pool, ownerId)),
        queryable: createOwnerBoundQueryable(pool, ownerId),
      }),
    );
  } catch (error) {
    if (error instanceof AuthError) return authJsonResponse(error, headers);
    const known = error instanceof GenerationJobError;
    if (!known) {
      const databaseCode =
        error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? error.code.slice(0, 32)
          : undefined;
      // Never log the message, request, owner, connection string or provider
      // payload: PostgreSQL/provider errors can embed sensitive values. The
      // exception class and bounded SQLSTATE-style code are enough to route an
      // operator toward connectivity vs permission vs implementation faults.
      console.error('[generation-request] unavailable', {
        stage,
        errorName: error instanceof Error ? error.name : typeof error,
        databaseCode,
      });
    }
    const status = known ? error.httpStatus : 503;
    if (status === 503 || status === 429) headers.set('Retry-After', '10');
    return generationResponse(
      {
        success: false,
        errorCode: known ? error.code : 'GENERATION_UNAVAILABLE',
        error: known ? error.code : 'Generation service unavailable',
      },
      headers,
      status,
    );
  }
}
export const commandKey = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9_.:-]+$/);
const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const reviewCommand = z
  .object({
    commandKey,
    expectedVersion: version,
    planRevision: version,
    outlines: z.array(z.unknown()).optional(),
    reviewHold: z.boolean().optional(),
  })
  .strict();
export const confirmCommand = z
  .object({ commandKey, expectedVersion: version, planRevision: version })
  .strict();
export const cancelCommand = z.object({ commandKey }).strict();
export const retryCommand = z
  .object({
    commandKey,
    expectedVersion: version,
    acknowledged: z.boolean().optional(),
    stepKeys: z.array(z.string().min(1).max(300)).max(100).optional(),
  })
  .strict();
export function parseCommand<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new GenerationJobError('INVALID_COMMAND', 400);
  return parsed.data;
}
