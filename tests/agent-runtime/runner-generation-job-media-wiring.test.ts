import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';
import { InMemorySessionRepo, Session } from '@earendil-works/pi-agent-core';
import type { ClaimedAgentSession } from '@openmaic/storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentSessionMediaConfig } from '@/lib/server/agent-runtime/course-tools';

const mocks = vi.hoisted(() => ({
  randomUUID: vi.fn(() => 'runner-test-uuid'),
  getAgentSessionStore: vi.fn(),
  getServerPersistenceProvider: vi.fn(),
  openEntryStorage: vi.fn(),
  resolveAgentDriverModel: vi.fn(),
  createCallLlmStreamFn: vi.fn(),
  buildAgent: vi.fn(),
  buildGenerationJobTools: vi.fn(() => []),
}));

vi.mock('node:crypto', async (importActual) => {
  const actual = await importActual<typeof import('node:crypto')>();
  return { ...actual, randomUUID: mocks.randomUUID };
});

vi.mock('@/lib/server/agent-runtime/store', () => ({
  getAgentSessionStore: mocks.getAgentSessionStore,
}));

vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: mocks.getServerPersistenceProvider,
}));

vi.mock('@/lib/server/agent-runtime/session-materials', async (importActual) => {
  const actual =
    await importActual<typeof import('@/lib/server/agent-runtime/session-materials')>();
  return { ...actual, listSessionMaterials: vi.fn(async () => []) };
});

vi.mock('@/lib/server/agent-runtime/entry-tree-storage', async (importActual) => {
  const actual =
    await importActual<typeof import('@/lib/server/agent-runtime/entry-tree-storage')>();
  return {
    ...actual,
    AgentSessionEntryStorage: {
      open: mocks.openEntryStorage,
    },
  };
});

vi.mock('@/lib/server/agent-runtime/model-preflight', () => ({
  preflightProModel: vi.fn(async () => ({ chatReady: true, generationReady: true })),
}));

vi.mock('@/lib/server/agent-runtime/agent-driver-model', async (importActual) => {
  const actual =
    await importActual<typeof import('@/lib/server/agent-runtime/agent-driver-model')>();
  return { ...actual, resolveAgentDriverModel: mocks.resolveAgentDriverModel };
});

vi.mock('@/lib/agent/runtime/stream-fn', () => ({
  createCallLlmStreamFn: mocks.createCallLlmStreamFn,
}));

vi.mock('@/lib/agent/runtime/build-agent', () => ({
  buildAgent: mocks.buildAgent,
}));

vi.mock('@/lib/server/agent-runtime/user-skills', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/server/agent-runtime/user-skills')>();
  return { ...actual, listUserSkills: vi.fn(async () => []) };
});

vi.mock('@/lib/server/agent-runtime/generation-job-tools', async (importActual) => {
  const actual =
    await importActual<typeof import('@/lib/server/agent-runtime/generation-job-tools')>();
  return { ...actual, buildGenerationJobTools: mocks.buildGenerationJobTools };
});

import { runSession } from '@/lib/server/agent-runtime/runner';

const SESSION_ID = 'session-1';
const WORKER_ID = `runner-t:${process.pid}`;

function makeMeta(): ClaimedAgentSession {
  return {
    id: SESSION_ID,
    ownerId: 'owner-1',
    prompt: 'Build a narrated course',
    stageId: 'stage-1',
    existingCourse: false,
    status: 'running',
    attempt: 1,
    createdAt: 1,
    updatedAt: 1,
    claimReason: 'queued',
    claimSeq: 0,
    deliveredUserMessageSeq: 0,
    activeMediaConfigRef: {
      id: '11111111-1111-4111-8111-111111111111',
      revision: 2,
    },
  };
}

function makeStore(meta: ClaimedAgentSession) {
  let seq = 0;
  return {
    appendRunEvent: vi.fn(async () => {
      seq += 1;
      return seq;
    }),
    clearCancel: vi.fn(async () => undefined),
    finishSession: vi.fn(async () => true),
    getSession: vi.fn(async () => ({ ...meta, lease: { workerId: WORKER_ID } })),
    hasSessionRunHistory: vi.fn(async () => false),
    heartbeat: vi.fn(async () => true),
    getCancelRequestedAt: vi.fn(async () => null),
    isCancelRequested: vi.fn(async () => false),
    listUserMessages: vi.fn(async () => []),
    registerSessionUrls: vi.fn(async () => []),
    releaseLease: vi.fn(async () => undefined),
    requeueForRetry: vi.fn(async () => false),
    requeueSession: vi.fn(async () => false),
  };
}

async function makeEntryTree(): Promise<Session> {
  const repo = new InMemorySessionRepo();
  return repo.create({ id: SESSION_ID });
}

function makeFakeAgent() {
  const messages: AgentMessage[] = [];
  return {
    subscribe: (_listener: (event: AgentEvent, signal?: AbortSignal) => void) => () => undefined,
    prompt: async () => undefined,
    continue: async () => undefined,
    waitForIdle: async () => undefined,
    steer: (_message: AgentMessage) => undefined,
    abort: () => undefined,
    state: {
      get messages() {
        return messages;
      },
      errorMessage: undefined,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.buildGenerationJobTools.mockReturnValue([]);
  mocks.resolveAgentDriverModel.mockResolvedValue({
    connection: { model: undefined, thinkingConfig: undefined },
    piModel: { api: 'openai-completions', provider: 'openai', id: 'driver-model' },
    wireMaxOutputTokens: undefined,
    reservedOutputTokens: 8192,
  });
  mocks.createCallLlmStreamFn.mockReturnValue((() => undefined) as never);
  mocks.getServerPersistenceProvider.mockResolvedValue({
    documentStore: { forOwner: () => ({}) },
  });
  mocks.buildAgent.mockImplementation(() => makeFakeAgent());
});

describe('generation job runner media wiring', () => {
  it('passes the loaded Pro media snapshot to the whole-course submission tools', async () => {
    const meta = makeMeta();
    const store = makeStore(meta);
    const session = await makeEntryTree();
    const mediaConfig: AgentSessionMediaConfig = {
      version: 2,
      imageEnabled: true,
      videoEnabled: false,
      ttsEnabled: true,
      ttsProviders: [],
      ttsVoiceDirectory: [],
    };
    mocks.openEntryStorage.mockResolvedValue(session.getStorage());
    mocks.getAgentSessionStore.mockResolvedValue(store);

    await runSession(
      {
        running: new Map(),
        shuttingDown: false,
        loadMediaConfigSnapshot: vi.fn(async () => mediaConfig),
      },
      meta,
    );

    expect(mocks.buildGenerationJobTools).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaConfigRef: meta.activeMediaConfigRef,
        mediaConfig,
      }),
    );
  });
});
