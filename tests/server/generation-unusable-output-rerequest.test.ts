import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseJsonResponse } from '@openmaic/generation';
import type { ModelSelection } from '@/lib/model-gateway';
import {
  startFakeModelServer,
  type FakeModelServer,
  type FakeReply,
} from '@/lib/model-gateway/testing/fake-openai-server';
import { resetTransportAgents } from '@/lib/model-gateway/runtime/transport';
import type { GenerationLease, StepStart } from '@/lib/server/generation-jobs/contracts';
import type { SceneOutline } from '@/lib/types/generation';
import {
  InvalidModelOutput,
  PipelineExecution,
  UnknownExternalOutcome,
  type CheckpointRepository,
} from '@/lib/server/generation-pipeline/execution';
import {
  GenerationServices,
  UNUSABLE_OUTPUT_REREQUESTS,
  type GenerationPlan,
} from '@/lib/server/generation-pipeline/services';

/**
 * Fake OpenAI-compatible model server: every chat completion takes the next
 * scripted reply. Requests go through the real model gateway with a user
 * connection to this server, so no real key or `.env.local` is used.
 */
type Reply = { text: string } | { status: number };
const fake = {
  replies: [] as Reply[],
  requests: 0,
};
let server: FakeModelServer;
let selection: ModelSelection;

beforeAll(async () => {
  server = await startFakeModelServer((): FakeReply => {
    fake.requests++;
    const reply = fake.replies.shift() ?? { status: 599 };
    return 'status' in reply
      ? { kind: 'error', status: reply.status }
      : { kind: 'auto', text: reply.text };
  });
  selection = {
    source: 'user',
    providerId: 'openai',
    modelId: 'fake-model',
    connection: { auth: 'api-key', apiKey: 'fake-test-key', baseUrl: `${server.origin}/v1` },
  };
});
afterAll(() => server.close());
beforeEach(() => {
  // The fake server listens on loopback, which user endpoints may reach only here.
  vi.stubEnv('ALLOW_LOCAL_NETWORKS', 'true');
  fake.replies = [];
  fake.requests = 0;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await resetTransportAgents();
});

/** Recorded step results replay on resume, as `generation_steps` does. */
class StepRepository implements CheckpointRepository {
  steps = new Map<string, { status: string; result?: unknown }>();
  failures: Array<{ stepKey: string; code: string; uncertain: boolean; errorSummary?: string }> =
    [];
  async skipStepWithWarning() {}
  async beginStep(_lease: GenerationLease, step: StepStart) {
    const previous = this.steps.get(step.key);
    if (previous && previous.status !== 'succeeded') throw new Error('STEP_NOT_RUNNABLE');
    if (!previous) this.steps.set(step.key, { status: 'running' });
    return {
      stepId: step.key,
      attemptId: step.external ? step.key : null,
      requestKey: step.key,
      status: previous?.status ?? 'running',
      result: previous?.result,
    };
  }
  async commitCheckpoint(_lease: GenerationLease, input: { stepKey: string; result: unknown }) {
    this.steps.set(input.stepKey, { status: 'succeeded', result: structuredClone(input.result) });
  }
  async failStep(
    _lease: GenerationLease,
    failure: { stepKey: string; code: string; uncertain: boolean; errorSummary?: string },
  ) {
    this.steps.set(failure.stepKey, { status: failure.uncertain ? 'uncertain' : 'failed' });
    this.failures.push(failure);
  }
  record(key: string, result: unknown) {
    this.steps.set(key, { status: 'succeeded', result });
  }
}

const lease: GenerationLease = {
  jobId: 'job-unusable-output',
  stageId: 'stage-unusable-output',
  ownerId: 'owner',
  workerId: 'worker',
  leaseEpoch: 1,
  ownershipEpoch: 1,
  planRevision: 1,
  input: {
    version: 1,
    requirements: { requirement: 'Teach how a pendulum clock keeps time.' },
    agents: { mode: 'generate' },
    review: { mode: 'auto' },
  },
};

function setup(repository = new StepRepository()) {
  const execution = new PipelineExecution(repository, lease, new AbortController().signal, {
    run: (_kind, _group, _signal, work) => work(),
  });
  const services = new GenerationServices(
    execution,
    lease.input,
    { read: vi.fn(), write: vi.fn() },
    selection,
  );
  return { repository, execution, services };
}

const slide: SceneOutline = {
  id: 'clock',
  order: 0,
  type: 'slide',
  title: 'Pendulum clock',
  description: 'How the escapement counts swings.',
  keyPoints: ['period', 'escapement'],
};
const quiz: SceneOutline = { ...slide, id: 'check', type: 'quiz', title: 'Check' };
const interactive: SceneOutline = {
  ...slide,
  id: 'swing',
  type: 'interactive',
  title: 'Swing it',
  widgetType: 'simulation',
  widgetOutline: { concept: 'pendulum period' },
};
const plan: GenerationPlan = { outlines: [slide], languageDirective: 'English' };

/** The 2026-10-03 MiniMax-M3 failure: a stray quote jsonrepair cannot fix. */
const BROKEN_SLIDE =
  '{"background":{"type":"solid","color":"#ffffff"},"elements":[{"type":"shape","left":40,"top":40,"width":200,"height":120,"path":"M 0 0 L 1 0 L 1 1 L 0 1 Z","viewBox":[1,1],"fill":"#eeeeee","fixedRatio":false"}]}';
const VALID_SLIDE = JSON.stringify({
  background: { type: 'solid', color: '#ffffff' },
  elements: [
    {
      type: 'text',
      left: 60,
      top: 60,
      width: 600,
      height: 80,
      content: '<p>The escapement releases one tooth per swing.</p>',
    },
  ],
});
const BROKEN_QUIZ = '[{"type":"single","question":"Why?","options":["A","B"],"answer":["A"]"}]';
const VALID_QUIZ = JSON.stringify([
  { type: 'single', question: 'What sets the period?', options: ['Length', 'Mass'], answer: ['A'] },
]);
const VALID_HTML = '<!DOCTYPE html><html><head></head><body><p>swing</p></body></html>';

const contentStep = (
  outline: SceneOutline,
  services: GenerationServices,
  execution: PipelineExecution,
) =>
  execution.checkpoint(`content:${outline.id}`, { outline }, () =>
    services.content(outline, [], plan),
  );

describe('bounded re-request for unusable model output', () => {
  it('uses outputs that JSON repair cannot fix', () => {
    expect(parseJsonResponse(BROKEN_SLIDE)).toBeNull();
    expect(parseJsonResponse(BROKEN_QUIZ)).toBeNull();
    expect(UNUSABLE_OUTPUT_REREQUESTS).toBe(1);
  });

  it.each([
    { name: 'slide', outline: slide, broken: BROKEN_SLIDE, valid: VALID_SLIDE },
    { name: 'quiz', outline: quiz, broken: BROKEN_QUIZ, valid: VALID_QUIZ },
    {
      name: 'interactive',
      outline: interactive,
      broken: 'Sorry, here is a plan.',
      valid: VALID_HTML,
    },
  ])('re-requests $name content under a fresh call key', async ({ outline, broken, valid }) => {
    const { repository, services, execution } = setup();
    fake.replies = [{ text: broken }, { text: valid }];

    const checkpoint = await contentStep(outline, services, execution);

    expect(checkpoint.content).toBeTruthy();
    expect(fake.requests).toBe(2);
    expect(repository.steps.get(`content:${outline.id}:call:0`)).toEqual({
      status: 'succeeded',
      result: broken,
    });
    expect(repository.steps.get(`content:${outline.id}:call:1`)).toEqual({
      status: 'succeeded',
      result: valid,
    });
    expect(repository.steps.get(`content:${outline.id}`)?.status).toBe('succeeded');
    expect(repository.failures).toEqual([]);
  });

  it('fails the step with a classified code once the re-request budget is spent', async () => {
    const { repository, services, execution } = setup();
    fake.replies = [{ text: BROKEN_SLIDE }, { text: BROKEN_SLIDE }, { text: VALID_SLIDE }];

    const failure = await contentStep(slide, services, execution).catch((error) => error);

    expect(failure).toBeInstanceOf(InvalidModelOutput);
    expect(failure).toMatchObject({ code: 'INVALID_CONTENT_RESULT' });
    expect(fake.requests).toBe(1 + UNUSABLE_OUTPUT_REREQUESTS);
    expect(repository.failures).toEqual([
      {
        stepKey: 'content:clock',
        code: 'INVALID_CONTENT_RESULT',
        uncertain: false,
        errorSummary: 'Model output was unusable after 2 call(s), including 1 fresh re-request(s).',
      },
    ]);
  });

  it('resumes by replaying recorded outputs and paying only for the unrecorded call', async () => {
    const { repository, services, execution } = setup();
    // A previous lease recorded the broken output, then stopped before re-requesting.
    repository.record('content:clock:call:0', BROKEN_SLIDE);
    fake.replies = [{ text: VALID_SLIDE }];

    await contentStep(slide, services, execution);

    expect(fake.requests).toBe(1);
    expect(repository.steps.get('content:clock:call:1')?.result).toBe(VALID_SLIDE);
  });

  it('grants a manual retry one more fresh call after an exhausted budget', async () => {
    const { repository, services, execution } = setup();
    repository.record('content:clock:call:0', BROKEN_SLIDE);
    repository.record('content:clock:call:1', BROKEN_SLIDE);
    fake.replies = [{ text: VALID_SLIDE }];

    await contentStep(slide, services, execution);

    expect(fake.requests).toBe(1);
    expect(repository.steps.get('content:clock:call:2')?.result).toBe(VALID_SLIDE);
  });

  it('never replays a re-request whose provider outcome is unknown', async () => {
    const { repository, services, execution } = setup();
    fake.replies = [{ text: BROKEN_SLIDE }, { status: 500 }, { text: VALID_SLIDE }];

    const failure = await contentStep(slide, services, execution).catch((error) => error);

    expect(failure).toBeInstanceOf(UnknownExternalOutcome);
    expect(fake.requests).toBe(2);
    expect(repository.failures).toEqual([
      expect.objectContaining({ stepKey: 'content:clock:call:1', uncertain: true }),
    ]);
  });

  it('re-requests an unparseable agent roster but not an invalid one', async () => {
    const roster = {
      difficulty: { level: 'introductory', rationale: 'One focused mechanism.' },
      agents: [
        { id: 'teacher', name: 'Teacher', role: 'teacher', persona: 'Explains the escapement.' },
        { id: 'peer', name: 'Peer', role: 'student', persona: 'Times the swings.' },
      ],
    };
    const parsed = setup();
    fake.replies = [{ text: '{"difficulty":{"level":"intro' }, { text: JSON.stringify(roster) }];
    const decision = await parsed.services.agents(plan);
    expect(Array.isArray(decision) ? decision : decision.agents).toHaveLength(2);
    expect(fake.requests).toBe(2);

    fake.requests = 0;
    const invalid = setup();
    fake.replies = [{ text: JSON.stringify({ ...roster, agents: roster.agents.slice(1) }) }];
    await expect(invalid.services.agents(plan)).rejects.toThrow('INVALID_AGENT_RESULT');
    expect(fake.requests).toBe(1);
  });
});
