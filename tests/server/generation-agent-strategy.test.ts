import { describe, expect, it, vi } from 'vitest';
import type { GenerationInput, GenerationLease } from '@/lib/server/generation-jobs/contracts';
import { PipelineExecution } from '@/lib/server/generation-pipeline/execution';
import { GenerationServices, type GenerationPlan } from '@/lib/server/generation-pipeline/services';

const lease: GenerationLease = {
  jobId: 'job-agent-strategy',
  stageId: 'stage-agent-strategy',
  ownerId: 'owner',
  workerId: 'worker',
  leaseEpoch: 1,
  ownershipEpoch: 1,
  planRevision: 7,
  input: {
    version: 1,
    requirements: {
      requirement:
        'Teach a beginner to diagnose a three-stage pump, assuming basic algebra, through a guided lab.',
      userNickname: 'Lin',
      userBio: 'First-year apprentice with no pump maintenance experience.',
    },
    agents: { mode: 'generate' },
    review: { mode: 'auto' },
  },
};

const plan: GenerationPlan = {
  courseTitle: 'Diagnosing a three-stage pump',
  languageDirective: 'English',
  outlines: [
    {
      id: 'inspect',
      order: 0,
      type: 'interactive',
      title: 'Inspect the system',
      description: 'Trace symptoms before choosing a repair.',
      keyPoints: ['pressure path', 'fault isolation'],
      teachingObjective: 'Select and justify a safe diagnostic sequence.',
      widgetType: 'procedural-skill',
      widgetOutline: {
        procedureType: 'inspection',
        task: 'Diagnose the pressure loss',
        steps: ['isolate power', 'measure each stage', 'compare readings'],
        successCriteria: ['identify the failed stage'],
      },
    },
  ],
};

function makeServices(input: GenerationInput = lease.input) {
  const execution = new PipelineExecution(
    {
      beginStep: vi.fn(),
      commitCheckpoint: vi.fn(),
      failStep: vi.fn(),
      skipStepWithWarning: vi.fn(),
    },
    { ...lease, input },
    new AbortController().signal,
    { run: (_kind, _group, _signal, work) => work() },
  );
  return new GenerationServices(execution, input, {
    read: vi.fn(),
    write: vi.fn(),
  });
}

describe('automatic classroom roster strategy', () => {
  it('decides difficulty and 2-5 course-specific roles in one outline-aware call', async () => {
    const services = makeServices();
    const aiCall = vi.fn(async (_systemPrompt: string, _userPrompt: string) =>
      JSON.stringify({
        difficulty: {
          level: 'applied',
          rationale: 'The learner must combine a safe procedure with multi-stage fault isolation.',
        },
        agents: [
          {
            id: 'lead-teacher',
            name: 'Mira',
            role: 'teacher',
            persona: 'Teaches safe diagnostic reasoning and checks each decision.',
          },
          {
            id: 'lab-partner',
            name: 'Tao',
            role: 'student',
            persona: 'Practises measurements and challenges unsupported conclusions.',
          },
        ],
      }),
    );
    vi.spyOn(services, 'modelCall').mockResolvedValue({ aiCall, resolved: {} as never });

    const checkpoint = await services.agents(plan);

    expect(aiCall).toHaveBeenCalledTimes(1);
    const [systemPrompt, userPrompt] = aiCall.mock.calls[0]!;
    expect(systemPrompt).toContain('2–5');
    expect(systemPrompt).toContain('Exactly one teacher');
    expect(userPrompt).toContain(lease.input.requirements.requirement);
    expect(userPrompt).toContain(lease.input.requirements.userBio!);
    expect(userPrompt).toContain(plan.courseTitle!);
    expect(userPrompt).toContain('Select and justify a safe diagnostic sequence.');
    expect(userPrompt).toContain('isolate power');
    expect(checkpoint).toEqual({
      kind: 'automatic-agent-decision',
      version: 1,
      strategyVersion: 'difficulty-v1',
      outlineVersion: 7,
      difficulty: {
        level: 'applied',
        rationale: 'The learner must combine a safe procedure with multi-stage fault isolation.',
      },
      agents: [
        {
          id: 'gen-job-agent-strategy-0',
          name: 'Mira',
          role: 'teacher',
          persona: 'Teaches safe diagnostic reasoning and checks each decision.',
        },
        {
          id: 'gen-job-agent-strategy-1',
          name: 'Tao',
          role: 'student',
          persona: 'Practises measurements and challenges unsupported conclusions.',
        },
      ],
    });
  });

  it.each([
    {
      name: 'fewer than two roles',
      result: {
        difficulty: { level: 'introductory', rationale: 'One focused objective.' },
        agents: [
          {
            id: 'teacher',
            name: 'Teacher',
            role: 'teacher',
            persona: 'Explains the objective.',
          },
        ],
      },
    },
    {
      name: 'duplicate role ids',
      result: {
        difficulty: { level: 'applied', rationale: 'Several diagnostic steps.' },
        agents: [
          { id: 'same', name: 'Teacher', role: 'teacher', persona: 'Guides diagnosis.' },
          { id: 'same', name: 'Peer', role: 'student', persona: 'Checks measurements.' },
        ],
      },
    },
    {
      name: 'blank responsibility',
      result: {
        difficulty: { level: 'applied', rationale: 'Several diagnostic steps.' },
        agents: [
          { id: 'teacher', name: 'Teacher', role: 'teacher', persona: 'Guides diagnosis.' },
          { id: 'peer', name: 'Peer', role: 'student', persona: '   ' },
        ],
      },
    },
    {
      name: 'duplicate responsibilities',
      result: {
        difficulty: { level: 'applied', rationale: 'Several diagnostic steps.' },
        agents: [
          { id: 'teacher', name: 'Teacher', role: 'teacher', persona: 'Checks each decision.' },
          { id: 'peer', name: 'Peer', role: 'student', persona: 'Checks each decision.' },
        ],
      },
    },
    {
      name: 'unsupported difficulty',
      result: {
        difficulty: { level: 'extreme', rationale: '' },
        agents: [
          { id: 'teacher', name: 'Teacher', role: 'teacher', persona: 'Guides diagnosis.' },
          { id: 'peer', name: 'Peer', role: 'student', persona: 'Checks measurements.' },
        ],
      },
    },
    {
      name: 'selected count disagreement',
      result: {
        selectedCount: 4,
        difficulty: { level: 'applied', rationale: 'Several diagnostic steps.' },
        agents: [
          { id: 'teacher', name: 'Teacher', role: 'teacher', persona: 'Guides diagnosis.' },
          { id: 'peer', name: 'Peer', role: 'student', persona: 'Checks measurements.' },
        ],
      },
    },
    {
      name: 'more than one teacher',
      result: {
        difficulty: { level: 'complex', rationale: 'Multiple perspectives.' },
        agents: [
          { id: 'teacher-a', name: 'Teacher A', role: 'teacher', persona: 'Explains theory.' },
          { id: 'teacher-b', name: 'Teacher B', role: 'teacher', persona: 'Runs the lab.' },
        ],
      },
    },
  ])('rejects $name instead of silently falling back', async ({ result }) => {
    const services = makeServices();
    const aiCall = vi.fn(async (_systemPrompt: string, _userPrompt: string) =>
      JSON.stringify(result),
    );
    vi.spyOn(services, 'modelCall').mockResolvedValue({ aiCall, resolved: {} as never });

    await expect(services.agents(plan)).rejects.toThrow('INVALID_AGENT_RESULT');
    expect(aiCall).toHaveBeenCalledTimes(1);
  });

  it('preserves an already-submitted legacy fixed count without reading settings', async () => {
    const legacyInput: GenerationInput = {
      ...lease.input,
      agents: { mode: 'generate', count: 3 },
    };
    const services = makeServices(legacyInput);
    const aiCall = vi.fn(async (_systemPrompt: string, _userPrompt: string) =>
      JSON.stringify({
        selectedCount: 3,
        difficulty: { level: 'applied', rationale: 'A legacy task with three roles.' },
        agents: [
          { id: 'teacher', name: 'Teacher', role: 'teacher', persona: 'Guides the course.' },
          { id: 'peer-a', name: 'Peer A', role: 'student', persona: 'Practises the task.' },
          { id: 'peer-b', name: 'Peer B', role: 'assistant', persona: 'Checks the result.' },
        ],
      }),
    );
    vi.spyOn(services, 'modelCall').mockResolvedValue({ aiCall, resolved: {} as never });

    const checkpoint = await services.agents(plan);

    expect(aiCall.mock.calls[0]?.[0]).toContain(
      'exactly 3 total agents for this legacy fixed-count task',
    );
    expect(Array.isArray(checkpoint) ? checkpoint : checkpoint.agents).toHaveLength(3);
  });

  it('passes a user-defined roster through without invoking automatic generation', async () => {
    const customAgents = [
      {
        id: 'custom-teacher',
        name: 'My teacher',
        role: 'teacher' as const,
        persona: 'Uses the teaching style selected by the user.',
      },
      {
        id: 'custom-peer',
        name: 'My peer',
        role: 'student' as const,
        persona: 'Uses the learner role selected by the user.',
      },
    ];
    const customInput: GenerationInput = {
      ...lease.input,
      agents: { mode: 'custom', items: customAgents },
    };
    const services = makeServices(customInput);
    const modelCall = vi.spyOn(services, 'modelCall');

    await expect(services.agents(plan)).resolves.toEqual(customAgents);
    expect(modelCall).not.toHaveBeenCalled();
  });
});
