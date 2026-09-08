import { describe, expect, it, vi } from 'vitest';
import { buildGenerationJobTools } from '@/lib/server/agent-runtime/generation-job-tools';

const view = {
  jobId: '57d27ca1-596a-4e6a-9a80-688fb58aeb58',
  stageId: 'stage-one',
  status: 'queued' as const,
  phase: 'preparing',
  stateVersion: 1,
  runNo: 1,
  planRevision: 0,
  readyScenes: 0,
  totalScenes: 0,
  warningCount: 0,
  lastErrorCode: null,
  reviewHold: false,
  autoContinueAt: null,
  pollUrl: '/api/generate-classroom/job',
  courseUrl: '/classroom/stage-one',
  pollIntervalMs: 2000,
};

describe('Pro durable whole-course tools', () => {
  it('submits one opaque owner/session-bound job and returns without polling', async () => {
    const createJob = vi.fn(async (_owner: string, _key: string, _input: unknown) => view);
    const repository = {
      createJob,
      getJob: vi.fn(),
      getJobBySession: vi.fn(),
      cancel: vi.fn(),
      getStageRevision: vi.fn(async () => 7),
    };
    const tools = buildGenerationJobTools({
      ownerId: 'owner',
      sessionId: 'session-one',
      repository,
      resolveModelConfigRef: async () => ({
        id: 'bde1e25a-19eb-4ce5-b40d-3c769b3a1bb4',
        revision: 1,
      }),
    });
    const submit = tools.find((tool) => tool.name === 'submit_course_generation')!;
    const execute = submit.execute as unknown as (
      callId: string,
      params: { requirement: string; targetStageId: string },
      signal?: AbortSignal,
      onUpdate?: unknown,
    ) => Promise<{ details: unknown }>;
    const response = await execute(
      'tool-call-one',
      { requirement: 'Build a course', targetStageId: 'stage-one' },
      undefined,
      undefined,
    );
    expect(response.details).toMatchObject({ jobId: view.jobId, phase: 'preparing' });
    expect(createJob).toHaveBeenCalledTimes(1);
    const [owner, idempotencyKey, input] = createJob.mock.calls[0]!;
    expect(owner).toBe('owner');
    expect(idempotencyKey).toMatch(/^pro:submit:/);
    expect(input).toMatchObject({
      source: { kind: 'pro', sessionId: 'session-one', submissionId: 'tool-call-one' },
      target: { stageId: 'stage-one', revision: 7 },
      modelConfigRef: { id: 'bde1e25a-19eb-4ce5-b40d-3c769b3a1bb4', revision: 1 },
    });
    expect(JSON.stringify(input)).not.toContain('apiKey');
  });

  it('recovers status and cancellation from the durable session relation', async () => {
    const getJobBySession = vi.fn(async () => view);
    const cancel = vi.fn(async () => ({ ...view, status: 'cancelled' as const }));
    const tools = buildGenerationJobTools({
      ownerId: 'owner',
      sessionId: 'session-one',
      repository: { createJob: vi.fn(), getJob: vi.fn(), getJobBySession, cancel },
    });
    await tools
      .find((tool) => tool.name === 'get_course_generation_status')!
      .execute('status', {} as never, undefined, undefined);
    await tools
      .find((tool) => tool.name === 'cancel_course_generation')!
      .execute('cancel', {} as never, undefined, undefined);
    expect(getJobBySession).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledWith(
      'owner',
      view.jobId,
      expect.objectContaining({ commandKey: expect.stringMatching(/^pro:cancel:/) }),
    );
  });

  it('submits confirmed agents and resolved skill constraints, rejecting unknown skills', async () => {
    const createJob = vi.fn(async (_owner: string, _key: string, _input: unknown) => view);
    const tools = buildGenerationJobTools({
      ownerId: 'owner',
      sessionId: 'session-one',
      repository: { createJob, getJob: vi.fn(), getJobBySession: vi.fn(), cancel: vi.fn() },
      resolveSkillConstraints: async (ids) =>
        ids.includes('valid') ? [{ id: 'valid', constraints: { firstSceneType: 'slide' } }] : [],
    });
    const submit = tools.find((tool) => tool.name === 'submit_course_generation')!;
    const agent = { id: 'teacher', name: 'Teacher', role: 'teacher', persona: 'Teaches' };
    await submit.execute('accepted', {
      requirement: 'Course', outlines: [{ id: 'one', type: 'slide', title: 'One', description: 'x', keyPoints: [], order: 0 }],
      agents: [agent], skillIds: ['valid'],
    } as never, undefined, undefined);
    expect(createJob.mock.calls[0]?.[2]).toMatchObject({
      agents: { mode: 'custom', items: [agent] },
      planning: { skillIds: ['valid'], skillConstraints: [{ id: 'valid' }] },
    });
    const refused = await submit.execute('refused', {
      requirement: 'Course', outlines: [{ id: 'one', type: 'slide', title: 'One', description: 'x', keyPoints: [], order: 0 }],
      skillIds: ['missing'],
    } as never, undefined, undefined) as { isError?: boolean };
    expect(refused.isError).toBe(true);
    expect(createJob).toHaveBeenCalledTimes(1);
  });

  it('requires explicit acknowledgement for unknown external results before retrying the same job', async () => {
    const attention = {
      ...view,
      status: 'needs_attention' as const,
      lastErrorCode: 'EXTERNAL_RESULT_UNKNOWN',
    };
    const retry = vi.fn(async () => ({ ...attention, status: 'queued' as const }));
    const createJob = vi.fn();
    const tools = buildGenerationJobTools({
      ownerId: 'owner',
      sessionId: 'session-one',
      repository: {
        createJob,
        getJob: vi.fn(),
        getJobBySession: vi.fn(async () => attention),
        cancel: vi.fn(),
        retry,
      },
    });
    const tool = tools.find((candidate) => candidate.name === 'retry_course_generation')!;
    const refused = await tool.execute('retry-without-confirmation', {} as never, undefined, undefined) as { isError?: boolean };
    expect(refused.isError).toBe(true);
    expect(retry).not.toHaveBeenCalled();

    await tool.execute(
      'retry-confirmed',
      { acknowledged: true } as never,
      undefined,
      undefined,
    );
    expect(retry).toHaveBeenCalledWith(
      'owner',
      view.jobId,
      expect.objectContaining({ acknowledged: true }),
    );
    expect(createJob).not.toHaveBeenCalled();
  });
});
