import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from '@/tests/helpers/signed-owner-request';

const mocks = vi.hoisted(() => ({
  runtimeEnabled: true,
  getSession: vi.fn(),
  setManualSessionTitle: vi.fn(),
}));

vi.mock('@/lib/config/feature-flags', () => ({
  isAgentRuntimeEnabled: () => mocks.runtimeEnabled,
  isAgentRuntimeConfigured: () => mocks.runtimeEnabled,
}));
vi.mock('@/lib/server/agent-runtime/owner', () => ({
  resolveRequestOwnerId: () => 'owner-1',
  resolveRequestOwnerIdAsync: async () => 'owner-1',
}));
vi.mock('@/lib/server/agent-runtime/store', () => ({
  getAgentSessionStore: async () => ({
    getSession: mocks.getSession,
    setManualSessionTitle: mocks.setManualSessionTitle,
  }),
}));

import { GET, PATCH } from '@/app/api/agent/sessions/[id]/route';

function call() {
  return GET(new NextRequest('http://localhost/api/agent/sessions/session-1'), {
    params: Promise.resolve({ id: 'session-1' }),
  });
}

function patch(body: BodyInit, id = 'session-1') {
  return PATCH(
    new NextRequest(`http://localhost/api/agent/sessions/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body,
    }),
    { params: Promise.resolve({ id }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runtimeEnabled = true;
  mocks.getSession.mockResolvedValue({ id: 'session-1', ownerId: 'owner-1', status: 'running' });
  mocks.setManualSessionTitle.mockImplementation(
    async (id: string, ownerId: string, title: string | null) => ({ id, ownerId, title }),
  );
});

describe('GET one agent session', () => {
  it('returns an owned session', async () => {
    const response = await call();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: 'session-1', status: 'running' });
  });

  it('does not expose a foreign session', async () => {
    mocks.getSession.mockResolvedValue({ id: 'session-1', ownerId: 'owner-2' });
    expect((await call()).status).toBe(404);
  });

  it.each(['not-a-real-id', 'x'.repeat(4096)])(
    'answers a malformed or oversized session id (%s) with not found',
    async (id) => {
      mocks.getSession.mockResolvedValue(null);

      const response = await GET(new NextRequest(`http://localhost/api/agent/sessions/${id}`), {
        params: Promise.resolve({ id }),
      });

      expect(mocks.getSession).toHaveBeenCalledWith(id);
      expect(response.status).toBe(404);
    },
  );
});

describe('PATCH agent session title', () => {
  it.each([
    ['trim', '  Focused question  ', 'Focused question'],
    ['explicit clear', null, null],
    ['surrogate-pair boundary', `${'x'.repeat(119)}😀tail`, 'x'.repeat(119)],
    ['NUL', `Safe\u0000 title`, 'Safe� title'],
  ])('normalizes %s before persisting', async (_name, title, expected) => {
    const response = await patch(JSON.stringify({ title }));

    expect(response.status).toBe(200);
    expect(mocks.setManualSessionTitle).toHaveBeenCalledWith('session-1', 'owner-1', expected);
    await expect(response.json()).resolves.toEqual({ title: expected });
  });

  it.each([
    ['malformed JSON', '{'],
    ['a missing title', JSON.stringify({})],
    ['a numeric title', JSON.stringify({ title: 42 })],
  ])('rejects %s', async (_name, body) => {
    expect((await patch(body)).status).toBe(400);
  });

  it('stays behind the runtime feature gate and owner scope', async () => {
    mocks.runtimeEnabled = false;
    expect((await patch(JSON.stringify({ title: 'Hidden' }))).status).toBe(404);
    mocks.runtimeEnabled = true;
    mocks.setManualSessionTitle.mockResolvedValue(null);
    expect((await patch(JSON.stringify({ title: 'Hidden' }))).status).toBe(404);
  });
});
