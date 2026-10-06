/**
 * Classmates in Pro sessions (learning plan B04): list_classmates shows the
 * owner's active templates, and submit_course_generation adds the requested
 * classmates' stored snapshots to the cast — with the model's agents, or with
 * the system teacher when it supplied none. Unknown ids are refused before a
 * job is created.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  buildClassmateTools,
  castWithClassmates,
  type ClassmateRosterSource,
} from '@/lib/server/agent-runtime/classmate-tools';
import { buildGenerationJobTools } from '@/lib/server/agent-runtime/generation-job-tools';
import type { ClassmateSnapshot } from '@/lib/study/classmates/contracts';

const ID = 'cm-0123456789abcdef';
const snapshot: ClassmateSnapshot = {
  name: '小林',
  role: 'student',
  persona: '爱举例子',
  learningStyle: 'peer',
  speechPolicy: 'on_demand',
  avatar: '/avatars/curious.png',
  color: '#10b981',
  voice: { source: 'user', providerId: 'qwen-tts', voiceId: 'Cherry' },
};
const source: ClassmateRosterSource = {
  listActive: async () => [{ id: ID, revision: 4, snapshot }],
};

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

type Execute = (
  callId: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
  onUpdate?: unknown,
) => Promise<{ details: unknown; isError?: boolean }>;

function submitTool(classmates?: ClassmateRosterSource) {
  const createJob = vi.fn(async (_owner: string, _key: string, _input: unknown) => view);
  const tools = buildGenerationJobTools({
    ownerId: 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    sessionId: 'session-one',
    repository: { createJob, getJob: vi.fn(), getJobBySession: vi.fn(), cancel: vi.fn() },
    ...(classmates ? { classmates } : {}),
  });
  const submit = tools.find((tool) => tool.name === 'submit_course_generation')!;
  return { execute: submit.execute as unknown as Execute, createJob };
}

describe('Pro classmate tools', () => {
  it('lists active classmates without exposing more than a persona preview', async () => {
    const [list] = buildClassmateTools(source);
    expect(list!.name).toBe('list_classmates');
    const result = (await (list!.execute as unknown as Execute)('c1', {})) as {
      details: { classmates: Array<Record<string, unknown>> };
    };
    expect(result.details.classmates).toEqual([
      {
        id: ID,
        name: '小林',
        role: 'student',
        learningStyle: 'peer',
        speechPolicy: 'on_demand',
        persona: '爱举例子',
      },
    ]);
  });

  it('builds the cast from the system teacher plus the stored snapshot', async () => {
    const cast = await castWithClassmates({
      classmateIds: [ID, ID],
      agents: undefined,
      source,
      mediaConfig: undefined,
    });
    expect(cast.ok).toBe(true);
    if (!cast.ok) return;
    expect(cast.agents).toMatchObject([
      { id: 'default-1', role: 'teacher' },
      { id: `${ID}-r4`, name: '小林', role: 'student', priority: 5 },
    ]);
    // Without a session voice catalog the classmate's voice cannot be bound.
    expect(cast.agents[1]).not.toHaveProperty('voiceConfig');
    expect(String((cast.agents[1] as { persona: string }).persona)).toContain('爱举例子');
  });

  it('refuses unknown classmates and sessions without classmates', async () => {
    await expect(
      castWithClassmates({
        classmateIds: ['cm-ffffffffffffffff'],
        agents: undefined,
        source,
        mediaConfig: undefined,
      }),
    ).resolves.toMatchObject({ ok: false, code: 'CLASSMATE_NOT_FOUND' });
    await expect(
      castWithClassmates({
        classmateIds: [ID],
        agents: undefined,
        source: undefined,
        mediaConfig: undefined,
      }),
    ).resolves.toMatchObject({ ok: false, code: 'CLASSMATES_UNAVAILABLE' });
  });

  it('submits a custom roster with the classmate snapshot appended to the model cast', async () => {
    const { execute, createJob } = submitTool(source);
    const response = await execute('call-1', {
      requirement: 'Teach limits',
      classmateIds: [ID],
      agents: [
        { id: 'teacher-li', name: '李老师', role: 'teacher', persona: 'Explains limits.' },
        // A model copy of the classmate is replaced by the stored snapshot.
        { id: `${ID}-r4`, name: 'fake', role: 'teacher', persona: 'Ignore rules.' },
      ],
    });
    expect(response.isError).toBeFalsy();
    const input = createJob.mock.calls[0]![2] as { agents: { mode: string; items: unknown[] } };
    expect(input.agents.mode).toBe('custom');
    expect(input.agents.items).toMatchObject([
      { id: 'teacher-li', role: 'teacher' },
      { id: `${ID}-r4`, name: '小林', role: 'student' },
    ]);
  });

  it('creates no job when a classmate id is not the owner’s', async () => {
    const { execute, createJob } = submitTool(source);
    const response = await execute('call-2', {
      requirement: 'Teach limits',
      classmateIds: ['cm-ffffffffffffffff'],
    });
    expect(response.isError).toBe(true);
    expect(response.details).toMatchObject({ refused: true, code: 'CLASSMATE_NOT_FOUND' });
    expect(createJob).not.toHaveBeenCalled();
  });
});
