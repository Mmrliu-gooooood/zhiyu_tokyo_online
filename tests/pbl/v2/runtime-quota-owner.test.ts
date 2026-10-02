import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

/**
 * Wiring guard: in background deployments every gateway call takes a provider
 * quota slot. Hosted web requests may only do that as the signed-in owner
 * (app_internal.acquire_provider_quota); without an owner the limiter falls
 * back to a direct INSERT that app_web is not granted, which surfaced as
 * "The model provider rejected the credentials" on every PBL v2 runtime turn.
 */
const mocks = vi.hoisted(() => ({
  resolveRequestBinding: vi.fn(),
  owners: [] as Array<string | undefined>,
}));

vi.mock('@/lib/auth/api', async () => {
  const { withProviderQuotaOwner } =
    await import('@/lib/server/generation-jobs/provider-call-context');
  return {
    withHostedProviderQuota: (_req: Request, handler: () => Promise<Response>) =>
      withProviderQuotaOwner('user:owner-a', handler),
  };
});
vi.mock('@/lib/model-gateway', async (importOriginal) =>
  (await import('@/tests/helpers/model-gateway-mock')).mockGatewayModule(
    await importOriginal(),
    mocks,
  ),
);
vi.mock('@/lib/pbl/v2/api/sse', async () => {
  const { getProviderQuotaOwner } =
    await import('@/lib/server/generation-jobs/provider-call-context');
  return {
    createSSEResponse: vi.fn(() => {
      mocks.owners.push(getProviderQuotaOwner());
      return new Response('ok');
    }),
  };
});
vi.mock('@/lib/pbl/v2/api/locale', () => ({
  applyRequestLocaleToProject: vi.fn(),
}));
vi.mock('@/lib/pbl/v2/agents/instructor', () => ({
  runInstructorTurn: vi.fn(),
}));
vi.mock('@/lib/pbl/v2/agents/simulator', () => ({
  runSimulatorTurn: vi.fn(),
}));
vi.mock('@/lib/pbl/v2/agents/evaluator', () => ({
  runTaskEvaluation: vi.fn(),
  runMilestoneEvaluation: vi.fn(),
  runFinalEvaluation: vi.fn(),
}));
vi.mock('@/lib/pbl/v2/operations/runtime/quiz-snapshot', () => ({
  applyQuizSignalsToProject: vi.fn(() => ({ updated: false, tierChanged: false })),
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new Request('http://localhost/api/pbl/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

describe('PBL v2 runtime routes take provider quota as the signed-in owner', () => {
  beforeEach(async () => {
    mocks.owners.length = 0;
    mocks.resolveRequestBinding.mockReset();
    const { getProviderQuotaOwner } =
      await import('@/lib/server/generation-jobs/provider-call-context');
    mocks.resolveRequestBinding.mockImplementation(async () => {
      mocks.owners.push(getProviderQuotaOwner());
      return { capabilities: { vision: false } };
    });
  });

  it.each([
    ['instructor', { project: { id: 'p' }, userMessage: 'hi' }],
    ['evaluate', { project: { id: 'p' }, kind: 'final' }],
    ['open-task', { project: { id: 'p' }, phase: 'greeting' }],
    ['simulator', { project: { id: 'p' }, userMessage: 'hi' }],
  ])(
    '%s resolves its model and opens its stream inside the owner scope',
    async (route, body) => {
      const { POST } = await import(`@/app/api/pbl/v2/${route}/route`);
      await POST(makeRequest(body));
      expect(mocks.owners.length).toBeGreaterThanOrEqual(2);
      expect(new Set(mocks.owners)).toEqual(new Set(['user:owner-a']));
    },
    // The first route import loads the PBL runtime graph.
    30_000,
  );
});

describe('every API route that resolves a model binds the quota owner', () => {
  const root = path.resolve(__dirname, '../../../app/api');
  const routes: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry === 'route.ts') routes.push(full);
    }
  };
  walk(root);

  it('finds the model routes', () => {
    expect(routes.length).toBeGreaterThan(10);
  });

  it('wraps each one with an owner-binding helper', () => {
    const unwrapped = routes
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        return /\bresolve(Request|Header)?Binding\(/.test(source);
      })
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        return !/\bwith(HostedProviderQuota|ApiPrincipal|ProviderQuotaOwner)\(/.test(source);
      })
      .map((file) => path.relative(root, file).replace(/\\/g, '/'));
    expect(unwrapped).toEqual([]);
  });
});
