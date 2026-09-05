import { z } from 'zod';
import { assertGenerationOrigin, resolveGenerationOwner } from './auth';
import { GenerationJobError } from './contracts';
import { assertGenerationReady, getGenerationPool } from './runtime';
import { GenerationJobRepository } from './repository';

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
  }) => Promise<Response>,
  options: { createSession?: boolean; submitting?: boolean } = {},
): Promise<Response> {
  const headers = new Headers({ 'Cache-Control': 'private, no-store' });
  try {
    assertGenerationOrigin(req);
    const ownerId = resolveGenerationOwner(req, headers, options.createSession);
    await assertGenerationReady(options.submitting);
    return await handler({
      ownerId,
      headers,
      repository: new GenerationJobRepository(getGenerationPool()),
    });
  } catch (error) {
    const known = error instanceof GenerationJobError;
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
