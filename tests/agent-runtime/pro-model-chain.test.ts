import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAgent } from '@/lib/agent/runtime/build-agent';
import { createGatewayStreamFn } from '@/lib/model-gateway/adapters/agent-stream-fn';
import { testBinding } from '@/tests/helpers/legacy-stream-gateway';
import {
  buildDslCourseToolset,
  type CourseDocument,
  type CourseStore,
} from '@/lib/server/agent-runtime/course-tools';
import { buildRunnerCoursePrompt } from '@/lib/server/agent-runtime/runner-contract';
import { resolveAgentDriverModel } from '@/lib/server/agent-runtime/agent-driver-model';
import { createGenerationAiCallFactory } from '@/lib/server/agent-runtime/generation-ai-call';
import { preflightProModel } from '@/lib/server/agent-runtime/model-preflight';
import { isModelConfigurationError, safeModelError } from '@/lib/server/agent-runtime/model-errors';
import type { Scene } from '@/lib/types/stage';
import type { ProModelContext } from '@/types/pro-model';

const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
  resolveBinding: vi.fn(),
  modelStream: vi.fn(),
  getStageRoute: vi.fn(),
}));
vi.mock('@/lib/model-gateway', async (importOriginal) => {
  const { mockGatewayModule } = await import('@/tests/helpers/model-gateway-mock');
  const { legacyStreamGateway } = await import('@/tests/helpers/legacy-stream-gateway');
  const driverGateway = legacyStreamGateway((...args) => mocks.modelStream(...args));
  return mockGatewayModule(await importOriginal(), {
    delegate: () => driverGateway,
    complete: mocks.complete,
    resolveBinding: mocks.resolveBinding,
  });
});
vi.mock('@/lib/server/model-routes', () => ({ getStageRoute: mocks.getStageRoute }));

const prior = '学过微积分、想练一阶微分方程方法判断';
const HOME_KEY = 'personal-secret';
const home: ProModelContext = {
  selection: {
    source: 'legacy-managed',
    providerId: 'openai',
    modelId: 'gpt-5.6',
    connection: { auth: 'api-key', apiKey: HOME_KEY, api: 'openai-responses' },
  },
};
/** The API key a resolver call received through its selection. */
function keyOf(input: { selection?: ProModelContext['selection'] }): string | undefined {
  const selection = input.selection;
  return selection?.source !== 'platform' && selection?.connection?.auth === 'api-key'
    ? selection.connection.apiKey
    : undefined;
}
const usage = {
  inputTokens: 10,
  outputTokens: 10,
  totalTokens: 20,
  inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getStageRoute.mockReturnValue(undefined);
  delete process.env.MODEL_ROUTES;
  delete process.env.DEFAULT_MODEL;
  mocks.resolveBinding.mockImplementation(async () =>
    testBinding({ modelId: 'gpt-5.6', modelString: 'openai:gpt-5.6' }),
  );
});

describe('PRO Home model complete generation chain', () => {
  it('runs driver tools through shared content/actions generators and persists a nonempty course with prior goals', async () => {
    const doc = {
      stage: { id: 'course', name: '微分方程', createdAt: 1, updatedAt: 1 },
      scenes: [],
    } as unknown as CourseDocument;
    const store = {
      loadDocument: async () => doc,
      putScene: vi.fn(async (_id: string, scene: Scene) => {
        const index = doc.scenes.findIndex((candidate) => candidate.id === scene.id);
        if (index >= 0) doc.scenes[index] = scene;
        else doc.scenes.push(scene);
      }),
      saveDocument: vi.fn(async (next: CourseDocument) => {
        Object.assign(doc, next);
      }),
    } as unknown as CourseStore;
    const assertActive = vi.fn(async () => undefined);
    const context = { ...home, assertActive };
    const driver = await resolveAgentDriverModel(context);
    mocks.complete.mockImplementation(async (_binding, req, { source: stage }) => {
      if (stage === 'scene-content:quiz') {
        expect(req.messages[0].content).toContain(prior);
        return {
          text: JSON.stringify([
            { id: 'q1', type: 'short_answer', question: '如何判断一阶微分方程是否可分离变量？' },
          ]),
        };
      }
      expect(stage).toBe('scene-actions');
      return {
        text: JSON.stringify([{ type: 'text', content: '利用已有微积分知识，判断变量能否分离。' }]),
      };
    });
    let turns = 0;
    mocks.modelStream.mockImplementation((params) => {
      const first = turns++ === 0;
      const transcript = JSON.stringify(params.messages);
      expect(transcript).toContain(prior);
      expect(transcript).not.toContain(HOME_KEY);
      return {
        fullStream: (async function* () {
          if (first)
            yield {
              type: 'tool-call',
              toolCallId: 'generate-1',
              toolName: 'generate_scene',
              input: {
                stageId: 'course',
                order: 1,
                title: '方法判断练习',
                type: 'quiz',
                brief: prior,
              },
            };
          else yield { type: 'text-delta', text: '课程已生成。' };
          yield { type: 'finish', finishReason: first ? 'tool-calls' : 'stop', totalUsage: usage };
        })(),
        usage: Promise.resolve(usage),
      };
    });
    const tools = buildDslCourseToolset({
      store,
      modelContext: context,
      stageAccess: async () => ({ kind: 'owned' }),
      onCheckpoint: vi.fn(),
      sessionId: 'session',
    });
    const agent = buildAgent({
      model: driver.piModel,
      streamFn: createGatewayStreamFn({
        binding: driver.binding,
        source: 'agent-runtime',
        beforeCall: assertActive,
      }),
      tools,
      allowedToolNames: new Set(['generate_scene']),
      systemPrompt: buildRunnerCoursePrompt({}),
      history: [{ role: 'user', content: [{ type: 'text', text: prior }], timestamp: 1 }],
    });
    await agent.prompt('生成课程');
    expect(agent.state.errorMessage).toBeUndefined();
    expect(mocks.modelStream).toHaveBeenCalledTimes(2);
    expect(doc.scenes).toHaveLength(1);
    expect(doc.scenes[0]?.type).toBe('quiz');
    expect(JSON.stringify(doc.scenes[0]?.content)).toContain('可分离变量');
    expect(doc.scenes[0]?.actions?.length).toBeGreaterThan(0);
    expect(mocks.resolveBinding.mock.calls.map(([input]) => input.stage)).toEqual([
      'maic-agent-driver',
      'scene-content:quiz',
      'scene-actions',
    ]);
    for (const [input] of mocks.resolveBinding.mock.calls) expect(keyOf(input)).toBe(HOME_KEY);
    expect(assertActive.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(JSON.stringify(doc)).not.toContain(HOME_KEY);
  });

  it('retains each explicit stage route and checks revocation even after cached resolution', async () => {
    mocks.getStageRoute.mockImplementation((stage) =>
      stage === 'scene-actions'
        ? { model: 'server:actions', api: 'openai-completions' }
        : undefined,
    );
    let revoked = false;
    const context = {
      ...home,
      assertActive: async () => {
        if (revoked) throw new Error('PRO_MODEL_REVOKED');
      },
    };
    mocks.complete.mockResolvedValue({ text: 'ok' });
    const factory = createGenerationAiCallFactory({ modelContext: context });
    await factory('scene-content:slide')('system', 'page');
    await factory('scene-actions')('system', 'actions');
    // resolveBinding lets a configured stage route override the connection
    // context (tests/model-gateway/selection/resolve-binding.test.ts).
    expect(keyOf(mocks.resolveBinding.mock.calls[0]![0])).toBe(HOME_KEY);
    expect(mocks.resolveBinding.mock.calls[0]![0].stage).toBe('scene-content:slide');
    expect(mocks.resolveBinding.mock.calls[1]?.[0].stage).toBe('scene-actions');
    revoked = true;
    await expect(factory('scene-content:slide')('system', 'page')).rejects.toThrow(
      'PRO_MODEL_REVOKED',
    );
    expect(mocks.complete).toHaveBeenCalledTimes(2);
    expect(mocks.resolveBinding).toHaveBeenCalledTimes(2);
  });

  it('preflight separates chatting from generating and strips remote secrets from errors', async () => {
    mocks.resolveBinding.mockImplementation(async ({ stage }) => {
      if (stage === 'maic-agent-driver')
        return testBinding({ modelId: 'gpt-5.6', modelString: 'openai:gpt-5.6' });
      throw new Error('401 invalid api key personal-secret https://secret.example?token=123');
    });
    expect(await preflightProModel(home)).toMatchObject({
      chatReady: true,
      generationReady: false,
      error: expect.stringContaining('PRO_MODEL_AUTH'),
    });
    expect(safeModelError(new Error('401 personal-secret'))).not.toContain('personal-secret');
    const authError = safeModelError(new Error('401 personal-secret'));
    expect(safeModelError(authError)).toBe(authError);
    expect(isModelConfigurationError(authError)).toBe(true);
    expect(isModelConfigurationError(safeModelError('429'))).toBe(false);
  });
});
