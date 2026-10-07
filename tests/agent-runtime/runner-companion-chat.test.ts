/**
 * Runner wiring for after-class classmate chats (learning plan B05).
 *
 * A claimed session bound in study_companion_chats is not run as a Pro
 * session: the agent receives only the companion toolset and prompt, no
 * skills are loaded, Pro model preflight is skipped, the turn record is
 * appended to the event log, and the options envelope is stripped from the
 * delivered question. When the chat cannot continue (archived classmate,
 * unusable own model) the run fails with that code and is not requeued.
 */
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';
import { InMemorySessionRepo, Session } from '@earendil-works/pi-agent-core';
import type { ClaimedAgentSession } from '@openmaic/storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  randomUUID: vi.fn(() => 'runner-test-uuid'),
  getAgentSessionStore: vi.fn(),
  getServerPersistenceProvider: vi.fn(),
  openEntryStorage: vi.fn(),
  resolveAgentDriverModel: vi.fn(),
  createCallLlmStreamFn: vi.fn(),
  buildAgent: vi.fn(),
  preflightProModel: vi.fn(async () => ({ chatReady: true, generationReady: true })),
  listSkills: vi.fn(async () => []),
  loadCompanionChat: vi.fn(),
  prepareCompanionRun: vi.fn(),
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
vi.mock('@/lib/server/agent-runtime/entry-tree-storage', async (importActual) => {
  const actual =
    await importActual<typeof import('@/lib/server/agent-runtime/entry-tree-storage')>();
  return { ...actual, AgentSessionEntryStorage: { open: mocks.openEntryStorage } };
});
vi.mock('@/lib/server/agent-runtime/model-preflight', () => ({
  preflightProModel: mocks.preflightProModel,
}));
vi.mock('@/lib/server/agent-runtime/agent-driver-model', async (importActual) => {
  const actual =
    await importActual<typeof import('@/lib/server/agent-runtime/agent-driver-model')>();
  return { ...actual, resolveAgentDriverModel: mocks.resolveAgentDriverModel };
});
vi.mock('@/lib/model-gateway/adapters/agent-stream-fn', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/model-gateway/adapters/agent-stream-fn')>()),
  createGatewayStreamFn: mocks.createCallLlmStreamFn,
}));
vi.mock('@/lib/agent/runtime/build-agent', () => ({ buildAgent: mocks.buildAgent }));
vi.mock('@/lib/server/agent-runtime/skills', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/server/agent-runtime/skills')>();
  return { ...actual, listSkills: mocks.listSkills, findSkill: vi.fn(async () => null) };
});
vi.mock('@/lib/server/agent-runtime/companion-run', () => ({
  loadCompanionChat: mocks.loadCompanionChat,
  prepareCompanionRun: mocks.prepareCompanionRun,
}));

import { runSession } from '@/lib/server/agent-runtime/runner';

const SESSION_ID = 'session-1';
const WORKER_ID = `runner-t:${process.pid}`;
const QUESTION = '为什么要换元？\n\n[[companion-options {"discuss":["cm-fedcba9876543210"]}]]';

function makeMeta(overrides: Partial<ClaimedAgentSession> = {}): ClaimedAgentSession {
  return {
    id: SESSION_ID,
    ownerId: 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    prompt: QUESTION,
    stageId: 'stage-1',
    existingCourse: false,
    status: 'running',
    attempt: 1,
    createdAt: 1,
    updatedAt: 1,
    claimReason: 'queued',
    claimSeq: 0,
    deliveredUserMessageSeq: 0,
    ...overrides,
  };
}

function makeStore(meta: ClaimedAgentSession) {
  let seq = 0;
  return {
    appendRunEvent: vi.fn(async () => (seq += 1)),
    pruneMessageUpdates: vi.fn(async () => undefined),
    finishSession: vi.fn(async () => true),
    getSession: vi.fn(async () => ({ ...meta, lease: { workerId: WORKER_ID } })),
    hasSessionRunHistory: vi.fn(async () => false),
    heartbeat: vi.fn(async () => true),
    getCancelRequestedAt: vi.fn(async () => null),
    listUserMessages: vi.fn(async () => []),
    registerSessionUrls: vi.fn(async () => []),
    releaseLease: vi.fn(async () => undefined),
    requeueForRetry: vi.fn(async () => false),
    requeueSession: vi.fn(async () => false),
    markUserMessageDelivered: vi.fn(async () => true),
  };
}

function makeFakeAgent(prompts: unknown[]) {
  const messages: AgentMessage[] = [];
  const listeners = new Set<(event: AgentEvent) => void>();
  return {
    subscribe: (listener: (event: AgentEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prompt: async (input: unknown) => {
      prompts.push(input);
    },
    continue: async () => {},
    waitForIdle: async () => {},
    steer: vi.fn(),
    abort: () => {},
    state: { messages, errorMessage: undefined },
  };
}

const chatRow = {
  sessionId: SESSION_ID,
  ownerId: 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  spaceId: 'space-a',
  classmateId: 'cm-0123456789abcdef',
  purpose: 'after_class_qa',
  origin: null,
  createdAt: '2026-10-07T00:00:00.000Z',
};

async function run(meta = makeMeta()) {
  const store = makeStore(meta);
  const session = await new InMemorySessionRepo().create({ id: SESSION_ID });
  mocks.openEntryStorage.mockResolvedValue((session as Session).getStorage());
  mocks.getAgentSessionStore.mockResolvedValue(store);
  const prompts: unknown[] = [];
  let options:
    | { systemPrompt: string; tools: Array<{ name: string }>; allowedToolNames: Set<string> }
    | undefined;
  mocks.buildAgent.mockImplementation((agentOptions) => {
    options = agentOptions;
    return makeFakeAgent(prompts);
  });
  await runSession({ running: new Map(), shuttingDown: false }, meta);
  return { store, options, prompts };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveAgentDriverModel.mockResolvedValue({
    binding: {} as never,
    piModel: { api: 'openai-completions', provider: 'openai', id: 'driver-model' },
    wireMaxOutputTokens: undefined,
    reservedOutputTokens: 8192,
  });
  mocks.createCallLlmStreamFn.mockReturnValue((() => {}) as never);
  mocks.getServerPersistenceProvider.mockResolvedValue({
    documentStore: { forOwner: () => ({}) },
  });
});

describe('runner: after-class classmate chats', () => {
  it('runs a bound session with the companion toolset only', async () => {
    mocks.loadCompanionChat.mockResolvedValue(chatRow);
    const tools = [
      { name: 'search_materials' },
      { name: 'read_material' },
      { name: 'invite_classmate' },
    ];
    mocks.prepareCompanionRun.mockResolvedValue({
      systemPrompt: '你是「小林」',
      tools,
      toolNames: new Set(tools.map((tool) => tool.name)),
      history: [],
      driver: {
        binding: { modelString: 'deepseek:deepseek-chat' },
        piModel: { api: 'openai-completions', provider: 'deepseek', id: 'deepseek-chat' },
      },
      turnInfo: { classmateId: 'cm-0123456789abcdef', revision: 3 },
      deliveredText: '为什么要换元？',
    });

    const { store, options, prompts } = await run();

    expect(options?.systemPrompt).toBe('你是「小林」');
    expect(options?.tools.map((tool) => tool.name)).toEqual([
      'search_materials',
      'read_material',
      'invite_classmate',
    ]);
    expect([...(options?.allowedToolNames ?? [])]).toEqual([
      'search_materials',
      'read_material',
      'invite_classmate',
    ]);
    expect(mocks.listSkills).not.toHaveBeenCalled();
    expect(mocks.preflightProModel).not.toHaveBeenCalled();
    expect(mocks.resolveAgentDriverModel).not.toHaveBeenCalled();
    expect(mocks.prepareCompanionRun).toHaveBeenCalledWith(
      expect.objectContaining({ chat: chatRow, turnText: QUESTION }),
    );
    const types = store.appendRunEvent.mock.calls.map(
      (call) => (call as unknown as [string, string, { type: string }])[2].type,
    );
    expect(types[0]).toBe('session_start');
    expect(types).toContain('study_companion_turn');
    expect(prompts).toEqual([expect.objectContaining({ role: 'user', content: '为什么要换元？' })]);
    expect(store.finishSession).toHaveBeenCalledWith(
      SESSION_ID,
      WORKER_ID,
      expect.objectContaining({ status: 'succeeded' }),
    );
  });

  it('fails with the chat code and does not requeue when the chat cannot continue', async () => {
    mocks.loadCompanionChat.mockResolvedValue(chatRow);
    const error = Object.assign(
      new Error('STUDY_CLASSMATE_ARCHIVED: this after-class chat cannot continue'),
      {
        name: 'CompanionRunError',
      },
    );
    mocks.prepareCompanionRun.mockRejectedValue(error);

    const { store, options } = await run();

    expect(options).toBeUndefined();
    expect(store.finishSession).toHaveBeenCalledWith(
      SESSION_ID,
      WORKER_ID,
      expect.objectContaining({
        status: 'failed',
        error: expect.stringMatching(/^STUDY_CLASSMATE_ARCHIVED: /),
      }),
    );
    expect(store.requeueSession).not.toHaveBeenCalled();
    expect(store.requeueForRetry).not.toHaveBeenCalled();
  });

  it('keeps the model reason in the failure code', async () => {
    mocks.loadCompanionChat.mockResolvedValue(chatRow);
    mocks.prepareCompanionRun.mockRejectedValue(
      Object.assign(
        new Error(
          'STUDY_CLASSMATE_MODEL_UNAVAILABLE:credential_missing: this after-class chat cannot continue',
        ),
        { name: 'CompanionRunError' },
      ),
    );
    const { store } = await run();
    expect(store.finishSession).toHaveBeenCalledWith(
      SESSION_ID,
      WORKER_ID,
      expect.objectContaining({
        error: expect.stringMatching(/^STUDY_CLASSMATE_MODEL_UNAVAILABLE:credential_missing: /),
      }),
    );
  });

  it('leaves Pro sessions untouched', async () => {
    mocks.loadCompanionChat.mockResolvedValue(null);
    await run(makeMeta({ prompt: 'Help me' }));
    // The Pro toolset itself is pinned by the other runner suites.
    expect(mocks.prepareCompanionRun).not.toHaveBeenCalled();
    expect(mocks.preflightProModel).toHaveBeenCalled();
    expect(mocks.resolveAgentDriverModel).toHaveBeenCalled();
  });
});
