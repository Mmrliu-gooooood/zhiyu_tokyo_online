import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  appendRunEvent: vi.fn(async (..._args: unknown[]) => 1),
  finishSession: vi.fn(async () => true),
  releaseLease: vi.fn(async () => undefined),
}));

vi.mock('@/lib/server/agent-runtime/store', () => ({
  getAgentSessionStore: vi.fn(async () => ({
    appendRunEvent: mocks.appendRunEvent,
    clearCancel: vi.fn(async () => undefined),
    finishSession: mocks.finishSession,
    getSession: vi.fn(async () => null),
    hasSessionRunHistory: vi.fn(async () => false),
    heartbeat: vi.fn(async () => true),
    getCancelRequestedAt: vi.fn(async () => null),
    isCancelRequested: vi.fn(async () => false),
    listUserMessages: vi.fn(async () => []),
    releaseLease: mocks.releaseLease,
    requeueForRetry: vi.fn(async () => false),
    requeueSession: vi.fn(async () => false),
  })),
}));

// The runner lists the session's materials to build the materials prompt
// block. No material store exists in this harness; an empty list keeps the
// prompt free of the block while the real tool builders stay loaded.
vi.mock('@/lib/server/agent-runtime/session-materials', async (importActual) => {
  const actual =
    await importActual<typeof import('@/lib/server/agent-runtime/session-materials')>();
  return { ...actual, listSessionMaterials: vi.fn(async () => []) };
});

vi.mock('@/lib/server/agent-runtime/entry-tree-storage', async (importActual) => {
  const actual =
    await importActual<typeof import('@/lib/server/agent-runtime/entry-tree-storage')>();
  const { InMemorySessionRepo } = await import('@earendil-works/pi-agent-core');
  return {
    ...actual,
    AgentSessionEntryStorage: {
      open: async () =>
        (await new InMemorySessionRepo().create({ id: 'session-order' })).getStorage(),
    },
  };
});

// This harness exercises runner lifecycle; model readiness has its own integration suite.
vi.mock('@/lib/server/agent-runtime/model-preflight', () => ({
  preflightProModel: vi.fn(async () => ({ chatReady: true, generationReady: true })),
}));

vi.mock('@/lib/server/agent-runtime/agent-driver-model', () => ({
  resolveAgentDriverModel: vi.fn(async () => {
    throw new Error('driver setup unavailable');
  }),
}));

// Skills are orthogonal to the behaviour under test; pin the runner to a
// deployment with NO installed skills so no user-skill store is touched.
vi.mock('@/lib/server/agent-runtime/skills', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/server/agent-runtime/skills')>();
  return {
    ...actual,
    listSkills: vi.fn(async () => []),
    findSkill: vi.fn(async () => null),
  };
});
vi.mock('@/lib/server/agent-runtime/user-skills', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/server/agent-runtime/user-skills')>();
  return { ...actual, listUserSkills: vi.fn(async () => []) };
});

import { runSession } from '@/lib/server/agent-runtime/runner';

describe('runSession durable event ordering', () => {
  beforeEach(() => vi.clearAllMocks());

  it('persists a lifecycle frame before any other runner event', async () => {
    const loadMediaConfigSnapshot = vi.fn(async () => ({ version: 1 as const }));
    await runSession(
      { running: new Map(), shuttingDown: false, loadMediaConfigSnapshot },
      {
        id: 'session-order',
        ownerId: 'owner-1',
        activeMediaConfigRef: {
          id: '11111111-1111-4111-8111-111111111111',
          revision: 2,
        },
        prompt: 'Build a lesson',
        stageId: 'stage-1',
        existingCourse: false,
        status: 'running',
        attempt: 1,
        createdAt: 1,
        updatedAt: 1,
        claimReason: 'queued',
        claimSeq: 0,
        deliveredUserMessageSeq: 0,
      },
    );

    expect(loadMediaConfigSnapshot).toHaveBeenCalledWith('owner-1', {
      id: '11111111-1111-4111-8111-111111111111',
      revision: 2,
    });

    expect(mocks.appendRunEvent).toHaveBeenCalled();
    expect(mocks.appendRunEvent.mock.calls[0]?.[2]).toMatchObject({
      type: 'session_start',
      attempt: 1,
    });
    expect(mocks.finishSession).toHaveBeenCalled();
    const types = mocks.appendRunEvent.mock.calls.map(
      (call) => (call[2] as { type?: string } | undefined)?.type,
    );
    expect(types.at(-1)).toBe('session_end');
    expect(types).not.toContain('session_interrupted');
  });
});
