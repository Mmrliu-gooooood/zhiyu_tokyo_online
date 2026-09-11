import { createServer } from 'node:http';
import { once } from 'node:events';

import { createDocumentHttpHandler } from '@openmaic/storage/server';
import { afterEach, expect, it, vi } from 'vitest';

import { createPersistenceDocumentConflictMapper } from '@/lib/persistence/document-http-conflicts';
import { GenerationJobError } from '@/lib/server/generation-jobs/contracts';

afterEach(() => {
  vi.restoreAllMocks();
});

it('maps the known generation ownership conflict to HTTP 409 with redacted correlation data', async () => {
  const putStage = vi.fn(async () => {
    throw new GenerationJobError('SERVER_OWNED_GENERATION', 409);
  });
  const handler = createDocumentHttpHandler(
    { putStage } as unknown as Parameters<typeof createDocumentHttpHandler>[0],
    {
      authenticate: async () => ({ learnerKey: 'diagnostic' }),
      validateStage: () => ({ valid: true, errors: [] }),
      mapStoreConflict: createPersistenceDocumentConflictMapper('request-safe-123'),
    },
  );
  const internalError = vi.spyOn(console, 'error').mockImplementation(() => {});
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('NO_TEST_PORT');
    const response = await fetch(`http://127.0.0.1:${address.port}/documents/diagnostic/stage`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'diagnostic', privatePrompt: 'must not be logged' }),
    });
    const body = (await response.json()) as { error: { code: string } };

    expect(putStage).toHaveBeenCalledOnce();
    expect({ status: response.status, code: body.error.code }).toEqual({
      status: 409,
      code: 'SERVER_OWNED_GENERATION',
    });
    expect(warning).toHaveBeenCalledWith('[persistence] document write conflict', {
      requestId: 'request-safe-123',
      stageId: 'diagnostic',
      operation: 'putStage',
      code: 'SERVER_OWNED_GENERATION',
    });
    expect(JSON.stringify(warning.mock.calls)).not.toContain('must not be logged');
    expect(internalError).not.toHaveBeenCalled();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it('keeps non-allowlisted generation errors private', () => {
  const mapper = createPersistenceDocumentConflictMapper('request-safe-456');
  expect(
    mapper(new GenerationJobError('COURSE_NOT_FOUND', 404), {
      operation: 'putStage',
      stageId: 'diagnostic',
    }),
  ).toBeUndefined();
});
