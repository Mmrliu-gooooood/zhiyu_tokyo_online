/**
 * Runner-level pins for capability-registered roster and voice-cloning wiring.
 *
 * The tool-level tests in roster-tools.test.ts / voice-clone-tools.test.ts
 * exercise the tools themselves. This file drives the actual `runSession` loop
 * through a fake agent (mocked `buildAgent`) so the RUNNER WIRING is
 * observable: the toolset the agent receives, the allowlist it is given, and
 * the system prompt it is built with all depend on whether this deployment has
 * a voice-registration backend:
 *
 * - configured: clip_audio AND register_voice are registered, the allowlist
 *   carries both, and the prompt mentions the register_voice workflow;
 * - unconfigured: only clip_audio is registered, the allowlist never names
 *   register_voice, and the prompt says registration is unavailable — the
 *   model never sees a tool that can only throw.
 *
 * The roster tools (list_voices / set_roster) are always registered, and the
 * roster prompt block is always present.
 */
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';
import { InMemorySessionRepo, Session } from '@earendil-works/pi-agent-core';
import type { AgentSessionMaterial, ClaimedAgentSession } from '@openmaic/storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { VoiceRegistrationAdapter } from '@/lib/audio/voice-registration';
import type { AgentSessionMediaConfig } from '@/lib/server/agent-runtime/course-tools';

const mocks = vi.hoisted(() => ({
  randomUUID: vi.fn(() => 'runner-test-uuid'),
  getAgentSessionStore: vi.fn(),
  getServerPersistenceProvider: vi.fn(),
  openEntryStorage: vi.fn(),
  resolveAgentDriverModel: vi.fn(),
  createCallLlmStreamFn: vi.fn(),
  buildAgent: vi.fn(),
  resolveWebSearchCapability: vi.fn(),
  listSessionMaterials: vi.fn(async (): Promise<AgentSessionMaterial[]> => []),
  enabledServerTTSProviderIds: vi.fn(),
  resolveTTSApiKey: vi.fn(),
  getVoiceRegistrationAdapter: vi.fn(),
  getOwnerScopedDocumentStore: vi.fn(),
  probeStageAccess: vi.fn(),
  generateTTS: vi.fn(),
  persistClassroomMediaBytes: vi.fn(),
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

vi.mock('@/lib/server/agent-runtime/owner-scoped-documents', () => ({
  getOwnerScopedDocumentStore: mocks.getOwnerScopedDocumentStore,
}));

vi.mock('@/lib/server/agent-runtime/curriculum-tools', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/server/agent-runtime/curriculum-tools')>();
  return { ...actual, probeStageAccess: mocks.probeStageAccess };
});

vi.mock('@/lib/audio/tts-providers', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/audio/tts-providers')>();
  return { ...actual, generateTTS: mocks.generateTTS };
});

vi.mock('@/lib/server/classroom-media-bytes', () => ({
  persistClassroomMediaBytes: mocks.persistClassroomMediaBytes,
}));

vi.mock('@/lib/server/agent-runtime/session-materials', async (importActual) => {
  const actual =
    await importActual<typeof import('@/lib/server/agent-runtime/session-materials')>();
  return { ...actual, listSessionMaterials: mocks.listSessionMaterials };
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

// This harness exercises runner lifecycle; model readiness has its own integration suite.
vi.mock('@/lib/server/agent-runtime/model-preflight', () => ({
  preflightProModel: vi.fn(async () => ({ chatReady: true, generationReady: true })),
}));

vi.mock('@/lib/server/agent-runtime/agent-driver-model', () => ({
  resolveAgentDriverModel: mocks.resolveAgentDriverModel,
}));

vi.mock('@/lib/agent/runtime/stream-fn', () => ({
  createCallLlmStreamFn: mocks.createCallLlmStreamFn,
}));

vi.mock('@/lib/agent/runtime/build-agent', () => ({
  buildAgent: mocks.buildAgent,
}));

vi.mock('@/lib/server/agent-runtime/web-search', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/server/agent-runtime/web-search')>();
  return {
    ...actual,
    resolveWebSearchCapability: mocks.resolveWebSearchCapability,
  };
});

// Keep the real tool builders and prompt assembly; only the capability inputs
// are faked, so the assertions observe the actual registered tools.
vi.mock('@/lib/server/provider-config', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/server/provider-config')>();
  return {
    ...actual,
    enabledServerTTSProviderIds: mocks.enabledServerTTSProviderIds,
    resolveTTSApiKey: mocks.resolveTTSApiKey,
  };
});

vi.mock('@/lib/audio/voice-registration', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/audio/voice-registration')>();
  return {
    ...actual,
    getVoiceRegistrationAdapter: mocks.getVoiceRegistrationAdapter,
  };
});

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

const SESSION_ID = 'session-1';
/** Mirrors the runner's `WORKER_ID` derivation with the fixed mock uuid. */
const WORKER_ID = `runner-t:${process.pid}`;

function fakeAdapter(): VoiceRegistrationAdapter {
  return {
    supportsRegistration: () => true,
    supportsBootstrapReferenceClip: false,
    resolveRegistrationModel: () => 'fake-model',
    voiceExists: async () => false,
    registerVoice: async (_cfg, params) => `voice-${params.voiceId}`,
    bootstrapReferenceClip: async () => {
      throw new Error('fake adapter cannot bootstrap');
    },
  };
}

function makeMeta(overrides: Partial<ClaimedAgentSession> = {}): ClaimedAgentSession {
  return {
    id: SESSION_ID,
    ownerId: 'owner-1',
    prompt: 'Help me',
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
    appendRunEvent: vi.fn(
      async (
        _id: string,
        _workerId: string,
        _event: { type: string; data?: Record<string, unknown> },
      ) => {
        seq += 1;
        return seq;
      },
    ),
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

interface FakeAgent {
  subscribe(listener: (event: AgentEvent, signal?: AbortSignal) => void): () => void;
  prompt(text: string): Promise<void>;
  continue(): Promise<void>;
  waitForIdle(): Promise<void>;
  steer(message: AgentMessage): void;
  abort(): void;
  readonly state: { messages: AgentMessage[]; errorMessage?: string };
}

function makeFakeAgent(): FakeAgent {
  const messages: AgentMessage[] = [];
  const listeners = new Set<(event: AgentEvent, signal?: AbortSignal) => void>();
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prompt: async () => {},
    continue: async () => {},
    waitForIdle: async () => {},
    steer: () => {},
    abort: () => {},
    state: {
      get messages() {
        return messages;
      },
      errorMessage: undefined,
    },
  };
}

interface BuildAgentOptions {
  systemPrompt: string;
  tools: Array<{
    name: string;
    execute?: (callId: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
  }>;
  allowedToolNames?: ReadonlySet<string>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listSessionMaterials.mockResolvedValue([]);
  mocks.resolveAgentDriverModel.mockResolvedValue({
    connection: { model: undefined, thinkingConfig: undefined },
    piModel: { api: 'openai-completions', provider: 'openai', id: 'driver-model' },
    wireMaxOutputTokens: undefined,
    reservedOutputTokens: 8192,
  });
  mocks.createCallLlmStreamFn.mockReturnValue((() => {}) as never);
  mocks.buildAgent.mockReturnValue(makeFakeAgent() as never);
  mocks.resolveWebSearchCapability.mockReturnValue(null);
  mocks.enabledServerTTSProviderIds.mockReturnValue([]);
  mocks.resolveTTSApiKey.mockReturnValue('sk-test');
  mocks.getVoiceRegistrationAdapter.mockReturnValue(undefined);
  mocks.getOwnerScopedDocumentStore.mockResolvedValue({});
  mocks.probeStageAccess.mockResolvedValue({ kind: 'owned' });
  mocks.generateTTS.mockResolvedValue({ audio: new Uint8Array([1, 2]), format: 'mp3' });
  mocks.persistClassroomMediaBytes.mockResolvedValue(
    '/api/classroom-media/stage-1/media/tts-speech-1.mp3',
  );
  mocks.getServerPersistenceProvider.mockResolvedValue({
    documentStore: { forOwner: () => ({}) },
  });
});

async function runToBuildAgent(
  runOptions: {
    meta?: ClaimedAgentSession;
    loadMediaConfigSnapshot?: (
      ownerId: string,
      ref: { id: string; revision: number },
    ) => Promise<AgentSessionMediaConfig>;
  } = {},
): Promise<BuildAgentOptions> {
  const meta = runOptions.meta ?? makeMeta();
  const session = await makeEntryTree();
  const store = makeStore(meta);
  mocks.openEntryStorage.mockResolvedValue(session.getStorage());
  mocks.getAgentSessionStore.mockResolvedValue(store);

  let options: BuildAgentOptions | undefined;
  mocks.buildAgent.mockImplementation((agentOptions: BuildAgentOptions) => {
    options = agentOptions;
    return makeFakeAgent();
  });

  await runSession(
    {
      running: new Map(),
      shuttingDown: false,
      ...(runOptions.loadMediaConfigSnapshot
        ? { loadMediaConfigSnapshot: runOptions.loadMediaConfigSnapshot }
        : {}),
    },
    meta,
  );

  expect(options, 'buildAgent must be called with the run options').toBeDefined();
  expect(store.finishSession).toHaveBeenCalledWith(
    SESSION_ID,
    WORKER_ID,
    expect.objectContaining({ status: 'succeeded' }),
  );
  return options!;
}

describe('voice tool runner registration', () => {
  it('threads the claimed session TTS snapshot into list_voices', async () => {
    mocks.resolveTTSApiKey.mockImplementation(
      (_id: string, snapshotKey?: string) => snapshotKey || '',
    );
    const options = await runToBuildAgent({
      meta: makeMeta({
        activeMediaConfigRef: {
          id: '11111111-1111-4111-8111-111111111111',
          revision: 1,
        },
      }),
      loadMediaConfigSnapshot: vi.fn(
        async (): Promise<AgentSessionMediaConfig> => ({
          version: 1,
          ttsEnabled: true,
          tts: [
            {
              providerId: 'minimax-tts',
              apiKey: 'session-secret',
              baseUrl: '',
              requiresApiKey: true,
              enabled: true,
              modelId: 'speech-2.8-hd',
              voice: 'female-yujie',
            },
          ],
        }),
      ),
    });
    const listVoices = options.tools.find((tool) => tool.name === 'list_voices');

    expect(listVoices?.execute).toBeTypeOf('function');
    const result = (await listVoices!.execute!('call', {}, undefined)) as {
      details: { voices: Array<{ binding: string }> };
    };
    expect(result.details.voices.map((voice) => voice.binding)).toContain(
      'minimax-tts::female-yujie',
    );
  });

  it('preserves the server voice catalog fallback for a v1 intent-only snapshot', async () => {
    mocks.enabledServerTTSProviderIds.mockReturnValue(['minimax-tts']);
    mocks.resolveTTSApiKey.mockReturnValue('server-secret');
    const options = await runToBuildAgent({
      meta: makeMeta({
        activeMediaConfigRef: {
          id: '11111111-1111-4111-8111-111111111112',
          revision: 1,
        },
      }),
      loadMediaConfigSnapshot: vi.fn(
        async (): Promise<AgentSessionMediaConfig> => ({
          version: 1,
          ttsEnabled: true,
        }),
      ),
    });
    const listVoices = options.tools.find((tool) => tool.name === 'list_voices')!;

    const result = (await listVoices.execute!('call', {}, undefined)) as {
      details: { voices: Array<{ providerId: string }> };
    };
    expect(result.details.voices).toEqual(
      expect.arrayContaining([expect.objectContaining({ providerId: 'minimax-tts' })]),
    );
    expect(JSON.stringify(result)).not.toContain('server-secret');
  });

  it('threads the complete v2 voice directory into list_voices and set_roster', async () => {
    mocks.resolveTTSApiKey.mockImplementation(
      (_id: string, snapshotKey?: string) => snapshotKey || '',
    );
    let document = {
      stage: {
        id: 'stage-1',
        name: 'Voice course',
        generatedAgentConfigs: [] as Array<{
          voiceConfig?: { providerId: string; modelId?: string; voiceId: string };
        }>,
        agentIds: [],
        updatedAt: 1,
      },
      scenes: [
        {
          id: 'scene-1',
          stageId: 'stage-1',
          order: 1,
          title: 'Voice page',
          type: 'slide',
          content: { type: 'slide', elements: [] },
          actions: [{ id: 'speech-1', type: 'speech', text: 'Hello' }],
        },
      ],
    };
    mocks.getOwnerScopedDocumentStore.mockResolvedValue({
      loadDocument: vi.fn(async () => structuredClone(document)),
      saveDocument: vi.fn(async (next) => {
        document = structuredClone(next) as typeof document;
      }),
      putScene: vi.fn(async (_stageId, scene) => {
        document.scenes = document.scenes.map((item) =>
          item.id === scene.id ? (structuredClone(scene) as typeof item) : item,
        );
      }),
    });
    const options = await runToBuildAgent({
      meta: makeMeta({
        activeMediaConfigRef: {
          id: '22222222-2222-4222-8222-222222222222',
          revision: 2,
        },
      }),
      loadMediaConfigSnapshot: vi.fn(
        async (): Promise<AgentSessionMediaConfig> => ({
          version: 2,
          ttsEnabled: true,
          ttsProviders: [
            {
              providerId: 'minimax-tts',
              apiKey: 'session-secret',
              baseUrl: 'https://api.minimaxi.com',
              requiresApiKey: true,
              enabled: true,
              modelId: 'speech-2.8-hd',
              speed: 1,
            },
          ],
          ttsDefault: {
            providerId: 'minimax-tts',
            modelId: 'speech-2.8-hd',
            voiceId: 'female-yujie',
            speed: 1,
          },
          ttsVoiceDirectory: [
            {
              providerId: 'minimax-tts',
              modelId: 'speech-2.8-hd',
              voiceIds: ['female-yujie', 'male-qn-jingying'],
            },
          ],
        }),
      ),
    });
    const listVoices = options.tools.find((tool) => tool.name === 'list_voices')!;

    const result = (await listVoices.execute!('call', {}, undefined)) as {
      details: { voices: Array<{ binding: string; modelId?: string }> };
    };
    expect(result.details.voices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          binding: 'minimax-tts::female-yujie',
          modelId: 'speech-2.8-hd',
        }),
        expect.objectContaining({
          binding: 'minimax-tts::male-qn-jingying',
          modelId: 'speech-2.8-hd',
        }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain('session-secret');

    const setRoster = options.tools.find((tool) => tool.name === 'set_roster')!;
    const rosterResult = (await setRoster.execute!(
      'set-roster',
      {
        stageId: 'stage-1',
        agents: [
          {
            id: 'teacher',
            name: 'Teacher',
            role: 'teacher',
            persona: 'Clear and patient.',
            voice: 'minimax-tts::male-qn-jingying',
          },
          { id: 'student', name: 'Student', role: 'student', persona: 'Curious.' },
        ],
      },
      undefined,
    )) as { isError?: boolean };
    expect(rosterResult.isError).toBeUndefined();
    expect(document.stage.generatedAgentConfigs[0]?.voiceConfig).toEqual({
      providerId: 'minimax-tts',
      modelId: 'speech-2.8-hd',
      voiceId: 'male-qn-jingying',
    });

    const generateTts = options.tools.find((tool) => tool.name === 'generate_tts')!;
    const ttsResult = await generateTts.execute!(
      'generate-tts',
      { stageId: 'stage-1', order: 1 },
      undefined,
    );
    expect(ttsResult).toMatchObject({
      details: { available: true, changed: true, generated: 1, failed: [] },
    });
    expect(mocks.generateTTS).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'minimax-tts',
        apiKey: 'session-secret',
        modelId: 'speech-2.8-hd',
        voice: 'male-qn-jingying',
      }),
      'Hello',
    );
    expect(JSON.stringify(ttsResult)).not.toContain('session-secret');
  });

  it('registers roster + clip + register_voice tools and both prompt blocks when a registration backend is configured', async () => {
    mocks.enabledServerTTSProviderIds.mockReturnValue(['fake-tts']);
    mocks.getVoiceRegistrationAdapter.mockImplementation((providerId: string) =>
      providerId === 'fake-tts' ? fakeAdapter() : undefined,
    );

    const options = await runToBuildAgent();

    expect(options.tools.map((tool) => tool.name)).toEqual([
      'ask_user',
      'create_skill',
      'read_skill',
      'patch_skill',
      'fetch_url',
      'generate_scene',
      'list_scenes',
      'generate_actions',
      'duplicate_scene',
      'import_pptx',
      'generate_image',
      'generate_tts',
      'edit_deck',
      'use_material_media',
      'read_stage',
      'patch_stage',
      'grep_stage',
      'create_stage',
      'create_folder',
      'move_to_folder',
      'rename_stage',
      'list_folder_stages',
      'read_stage_outline',
      'list_materials',
      'read_material',
      'search_material',
      'extract_material',
      'wait_for_materials',
      'list_voices',
      'set_roster',
      'clip_audio',
      'register_voice',
      'search_classrooms',
      'read_classroom',
      'search_chats',
      'read_chat',
      'submit_course_generation',
      'get_course_generation_status',
      'cancel_course_generation',
      'retry_course_generation',
    ]);
    expect([...(options.allowedToolNames ?? [])].sort()).toEqual(
      [
        'ask_user',
        'cancel_course_generation',
        'clip_audio',
        'create_folder',
        'create_skill',
        'create_stage',
        'duplicate_scene',
        'edit_deck',
        'extract_material',
        'fetch_url',
        'generate_actions',
        'generate_image',
        'generate_scene',
        'generate_tts',
        'get_course_generation_status',
        'grep_stage',
        'import_pptx',
        'list_folder_stages',
        'list_materials',
        'list_scenes',
        'list_voices',
        'move_to_folder',
        'patch_skill',
        'patch_stage',
        'read_chat',
        'read_classroom',
        'read_material',
        'read_skill',
        'read_stage',
        'read_stage_outline',
        'register_voice',
        'rename_stage',
        'retry_course_generation',
        'search_chats',
        'search_classrooms',
        'search_material',
        'set_roster',
        'submit_course_generation',
        'use_material_media',
        'wait_for_materials',
      ].sort(),
    );
    expect(options.systemPrompt).toContain('set_roster');
    expect(options.systemPrompt).toContain('list_voices');
    expect(options.systemPrompt).toContain('register_voice the returned clipId');
  });

  it('registers clip_audio but not register_voice when no adapter supports registration', async () => {
    mocks.enabledServerTTSProviderIds.mockReturnValue([]);
    mocks.getVoiceRegistrationAdapter.mockReturnValue(undefined);

    const options = await runToBuildAgent();

    expect(options.tools.map((tool) => tool.name)).toEqual([
      'ask_user',
      'create_skill',
      'read_skill',
      'patch_skill',
      'fetch_url',
      'generate_scene',
      'list_scenes',
      'generate_actions',
      'duplicate_scene',
      'import_pptx',
      'generate_image',
      'generate_tts',
      'edit_deck',
      'use_material_media',
      'read_stage',
      'patch_stage',
      'grep_stage',
      'create_stage',
      'create_folder',
      'move_to_folder',
      'rename_stage',
      'list_folder_stages',
      'read_stage_outline',
      'list_materials',
      'read_material',
      'search_material',
      'extract_material',
      'wait_for_materials',
      'list_voices',
      'set_roster',
      'clip_audio',
      'search_classrooms',
      'read_classroom',
      'search_chats',
      'read_chat',
      'submit_course_generation',
      'get_course_generation_status',
      'cancel_course_generation',
      'retry_course_generation',
    ]);
    expect([...(options.allowedToolNames ?? [])].sort()).toEqual(
      [
        'ask_user',
        'cancel_course_generation',
        'clip_audio',
        'create_folder',
        'create_skill',
        'create_stage',
        'duplicate_scene',
        'edit_deck',
        'extract_material',
        'fetch_url',
        'generate_actions',
        'generate_image',
        'generate_scene',
        'generate_tts',
        'get_course_generation_status',
        'grep_stage',
        'import_pptx',
        'list_folder_stages',
        'list_materials',
        'list_scenes',
        'list_voices',
        'move_to_folder',
        'patch_skill',
        'patch_stage',
        'read_chat',
        'read_classroom',
        'read_material',
        'read_skill',
        'read_stage',
        'read_stage_outline',
        'rename_stage',
        'retry_course_generation',
        'search_chats',
        'search_classrooms',
        'search_material',
        'set_roster',
        'submit_course_generation',
        'use_material_media',
        'wait_for_materials',
      ].sort(),
    );
    // The model is told registration is unavailable instead of being handed a
    // tool that can only throw.
    expect(options.systemPrompt).not.toContain('register_voice the returned clipId');
    expect(options.systemPrompt).toContain('no voice registration backend');
    // Roster guidance is always present (the roster tools are always registered).
    expect(options.systemPrompt).toContain('list_voices');
    expect(options.systemPrompt).toContain('set_roster');
  });

  it('registers clip_audio but not register_voice when the served adapter reports supportsRegistration false', async () => {
    mocks.enabledServerTTSProviderIds.mockReturnValue(['fake-tts']);
    const adapter = fakeAdapter();
    adapter.supportsRegistration = () => false;
    mocks.getVoiceRegistrationAdapter.mockReturnValue(adapter);

    const options = await runToBuildAgent();

    const names = options.tools.map((tool) => tool.name);
    expect(names).toContain('clip_audio');
    expect(names).not.toContain('register_voice');
    expect([...(options.allowedToolNames ?? [])]).not.toContain('register_voice');
  });
});
