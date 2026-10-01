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
  it('accepts introductory and complex decisions with different valid roster sizes and one teacher', async () => {
    const introductoryInput: GenerationInput = {
      ...lease.input,
      requirements: {
        requirement:
          'Introduce one focused concept to a complete beginner with one guided example.',
        userBio: 'No prior experience.',
      },
    };
    const complexInput: GenerationInput = {
      ...lease.input,
      requirements: {
        requirement:
          'Teach an experienced team to integrate safety, diagnosis, optimization, and trade-off analysis across a multi-stage system.',
        userBio: 'Experienced technicians preparing for cross-functional incident leadership.',
      },
    };
    const introductoryPlan: GenerationPlan = {
      courseTitle: 'One focused concept',
      languageDirective: 'English',
      outlines: [
        {
          ...plan.outlines[0]!,
          id: 'introductory-concept',
          title: 'Recognize the core idea',
          description: 'Explain and practise one foundational idea.',
          keyPoints: ['one definition', 'one guided example'],
          teachingObjective: 'Recognize and explain one foundational concept.',
          widgetType: undefined,
          widgetOutline: undefined,
        },
      ],
    };
    const complexPlan: GenerationPlan = {
      courseTitle: 'Integrated system incident leadership',
      languageDirective: 'English',
      outlines: [
        {
          ...plan.outlines[0]!,
          id: 'integrated-analysis',
          title: 'Coordinate an integrated response',
          description: 'Balance safety, diagnosis, optimization, and stakeholder trade-offs.',
          keyPoints: [
            'causal diagnosis',
            'safety constraints',
            'optimization',
            'trade-off analysis',
          ],
          teachingObjective: 'Synthesize multiple perspectives into a defensible response plan.',
        },
      ],
    };
    const introductoryServices = makeServices(introductoryInput);
    const complexServices = makeServices(complexInput);
    const introductoryCall = vi.fn(async (_systemPrompt: string, _userPrompt: string) =>
      JSON.stringify({
        difficulty: {
          level: 'introductory',
          rationale: 'A novice is learning one focused concept through one guided example.',
        },
        agents: [
          {
            id: 'teacher',
            name: 'Teacher',
            role: 'teacher',
            persona: 'Explains the foundational concept and checks comprehension.',
          },
          {
            id: 'learner',
            name: 'Learner',
            role: 'student',
            persona: 'Attempts the guided example and voices beginner misconceptions.',
          },
        ],
      }),
    );
    const complexCall = vi.fn(async (_systemPrompt: string, _userPrompt: string) =>
      JSON.stringify({
        difficulty: {
          level: 'complex',
          rationale:
            'Experienced learners must integrate four interdependent perspectives and defend trade-offs.',
        },
        agents: [
          {
            id: 'teacher',
            name: 'Lead teacher',
            role: 'teacher',
            persona: 'Integrates the perspectives and evaluates the final response plan.',
          },
          {
            id: 'safety',
            name: 'Safety specialist',
            role: 'assistant',
            persona: 'Challenges decisions against operational safety constraints.',
          },
          {
            id: 'diagnostician',
            name: 'Diagnostician',
            role: 'student',
            persona: 'Builds and tests the causal fault hypothesis.',
          },
          {
            id: 'optimizer',
            name: 'Optimizer',
            role: 'student',
            persona: 'Evaluates efficiency options and second-order effects.',
          },
          {
            id: 'stakeholder',
            name: 'Stakeholder',
            role: 'student',
            persona: 'Tests whether trade-offs are defensible to affected teams.',
          },
        ],
      }),
    );
    vi.spyOn(introductoryServices, 'modelCall').mockResolvedValue({
      aiCall: introductoryCall,
      binding: {} as never,
    });
    vi.spyOn(complexServices, 'modelCall').mockResolvedValue({
      aiCall: complexCall,
      binding: {} as never,
    });

    const introductory = await introductoryServices.agents(introductoryPlan);
    const complex = await complexServices.agents(complexPlan);
    if (Array.isArray(introductory) || Array.isArray(complex))
      throw new Error('Expected versioned automatic decisions');

    expect(introductory.agents).toHaveLength(2);
    expect(complex.agents).toHaveLength(5);
    expect(introductory.agents).not.toHaveLength(complex.agents.length);
    for (const decision of [introductory, complex]) {
      expect(decision.agents.filter((agent) => agent.role === 'teacher')).toHaveLength(1);
      expect(decision.difficulty.rationale).not.toHaveLength(0);
    }
    expect(introductory.difficulty).toEqual({
      level: 'introductory',
      rationale: 'A novice is learning one focused concept through one guided example.',
    });
    expect(complex.difficulty).toEqual({
      level: 'complex',
      rationale:
        'Experienced learners must integrate four interdependent perspectives and defend trade-offs.',
    });
    expect(introductoryCall.mock.calls[0]?.[1]).toContain(
      introductoryInput.requirements.requirement,
    );
    expect(complexCall.mock.calls[0]?.[1]).toContain(complexInput.requirements.requirement);
    expect(complexCall.mock.calls[0]?.[1]).toContain(
      'Synthesize multiple perspectives into a defensible response plan.',
    );
  });

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
    vi.spyOn(services, 'modelCall').mockResolvedValue({ aiCall, binding: {} as never });

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
    vi.spyOn(services, 'modelCall').mockResolvedValue({ aiCall, binding: {} as never });

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
    vi.spyOn(services, 'modelCall').mockResolvedValue({ aiCall, binding: {} as never });

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
