import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  query: vi.fn(),
  assertOwned: vi.fn(),
  background: vi.fn(),
}));

vi.mock('@/lib/auth/api', () => ({ hostedAuthGate: async () => null }));
vi.mock('@/lib/db/request-queryable', () => ({
  createOwnerBoundQueryable: () => ({ query: mocks.query }),
}));
vi.mock('@/lib/server/agent-runtime/owner', () => ({
  resolveRequestOwnerIdAsync: async () => 'owner-a',
}));
vi.mock('@/lib/server/heavy-task-admission/foreground-generation', () => ({
  FOREGROUND_GENERATION_ROOT_HEADER: 'x-generation-root-stage-id',
  FOREGROUND_GENERATION_SESSION_HEADER: 'x-generation-root-session-id',
  acquireForegroundGenerationRoot: mocks.acquire,
}));
vi.mock('@/lib/server/generation-jobs/ownership', () => ({
  assertClientGenerationAllowed: mocks.assertOwned,
}));
vi.mock('@/lib/server/generation-jobs/runtime', () => ({
  backgroundGenerationEnabled: mocks.background,
  getGenerationRequestPool: () => ({}),
}));

import { guardClientGeneration } from '@/lib/server/generation-jobs/route-guard';

function request(stageId: string, rootStageId = stageId) {
  return new Request('http://localhost/api/generate/scene-content', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-generation-root-stage-id': rootStageId,
      'x-generation-root-session-id': 'session-1',
    },
    body: JSON.stringify({ stageId }),
  });
}

describe('foreground generation route guard', () => {
  beforeEach(() => {
    vi.stubEnv('DATABASE_URL', 'postgres://test');
    mocks.acquire.mockReset().mockResolvedValue({ allowed: true });
    mocks.query.mockReset().mockResolvedValue({ rows: [] });
    mocks.assertOwned.mockReset();
    mocks.background.mockReset().mockReturnValue(false);
  });

  afterEach(() => vi.unstubAllEnvs());

  it('admits a not-yet-persisted stage through one stable course root', async () => {
    await expect(guardClientGeneration(request('stage-a'))).resolves.toBeNull();
    expect(mocks.acquire).toHaveBeenCalledExactlyOnceWith('owner-a', 'stage-a', 'session-1');
    expect(mocks.assertOwned).not.toHaveBeenCalled();
  });

  it('rejects a root/body mismatch before acquiring capacity', async () => {
    const response = await guardClientGeneration(request('stage-a', 'stage-b'));
    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toMatchObject({
      errorCode: 'FOREGROUND_GENERATION_ROOT_MISMATCH',
    });
    expect(mocks.acquire).not.toHaveBeenCalled();
  });

  it('requires a generation-session fence for a foreground root', async () => {
    const req = request('stage-a');
    req.headers.delete('x-generation-root-session-id');
    const response = await guardClientGeneration(req);
    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toMatchObject({
      errorCode: 'FOREGROUND_GENERATION_SESSION_REQUIRED',
    });
    expect(mocks.acquire).not.toHaveBeenCalled();
  });

  it('returns the stable personal capacity response before provider work', async () => {
    mocks.acquire.mockResolvedValue({ allowed: false, reason: 'personal_limit' });
    const response = await guardClientGeneration(request('stage-a'));
    expect(response?.status).toBe(429);
    await expect(response?.json()).resolves.toMatchObject({
      errorCode: 'HEAVY_TASK_PERSONAL_CAPACITY_LIMIT',
    });
  });

  it('rejects a deleted account before provider work', async () => {
    mocks.acquire.mockResolvedValue({ allowed: false, reason: 'account_inactive' });
    const response = await guardClientGeneration(request('stage-a'));
    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toMatchObject({ errorCode: 'ACCOUNT_INACTIVE' });
  });

  it('still enforces ownership after the stage has been persisted', async () => {
    mocks.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    await expect(guardClientGeneration(request('stage-a'))).resolves.toBeNull();
    expect(mocks.assertOwned).toHaveBeenCalledOnce();
  });

  it('allows independently admitted classroom speech in background mode while blocking legacy course generation', async () => {
    mocks.background.mockReturnValue(true);
    const speech = new Request('http://localhost:3000/api/generate/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
      body: JSON.stringify({ text: '课堂讨论语音', audioId: 'discussion-audio' }),
    });
    const denied = await guardClientGeneration(speech);
    expect(denied?.status).toBe(409);
    await expect(denied?.json()).resolves.toMatchObject({
      errorCode: 'BACKGROUND_GENERATION_REQUIRED',
    });
    await expect(
      guardClientGeneration(speech, { allowBackgroundIndependentMedia: true }),
    ).resolves.toBeNull();
    const crossSite = new Request(speech, { headers: { origin: 'https://foreign.example' } });
    const rejected = await guardClientGeneration(crossSite, {
      allowBackgroundIndependentMedia: true,
    });
    expect(rejected?.status).toBe(403);
  });
});
