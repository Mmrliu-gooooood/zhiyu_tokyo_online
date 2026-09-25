import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ storeSnapshot: vi.fn() }));
vi.mock('@/lib/server/provider-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/provider-config')>()),
  resolvePlatformDefault: () => ({ defaultId: 'zhiyu-default-text', revision: 'current' }),
}));
vi.mock('@/lib/server/generation-jobs/auth', () => ({
  assertGenerationOrigin: () => {},
  resolveGenerationOwner: () => 'signed-owner',
  resolveGenerationOwnerAsync: async () => 'signed-owner',
}));
vi.mock('@/lib/server/generation-jobs/runtime', () => ({
  assertGenerationRequestReady: async () => {},
  getGenerationRequestPool: () => ({}),
}));
vi.mock('@/lib/db/request-queryable', () => ({
  createOwnerBoundTransactionSource: (pool: unknown) => pool,
  createOwnerBoundQueryable: () => ({ query: async () => ({ rows: [] }) }),
}));
vi.mock('@/lib/server/generation-model-snapshots', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/generation-model-snapshots')>()),
  syncGenerationModelSnapshot: mocks.storeSnapshot,
}));

import { POST } from '@/app/api/generate-classroom/model-snapshots/route';

describe('generation snapshot HTTP error boundary', () => {
  it.each(['obsolete', undefined])(
    'preserves the platform revision conflict as HTTP 409 (%s)',
    async (revision) => {
      const response = await POST(
        new Request('http://localhost:3000/api/generate-classroom/model-snapshots', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000' },
          body: JSON.stringify({ source: 'platform', defaultId: 'zhiyu-default-text', revision }),
        }),
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ errorCode: 'PRO_MODEL_CONNECTION_STALE' });
      expect(mocks.storeSnapshot).not.toHaveBeenCalled();
    },
  );
});
