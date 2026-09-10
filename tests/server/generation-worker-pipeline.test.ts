import { describe, expect, it, vi } from 'vitest';
import { ConfirmedMediaFailure } from '@/lib/media/generation-errors';
import {
  generateTTS,
  TTSConfigurationError,
  TTSProviderTerminalError,
  TTSRequestTimeoutError,
} from '@/lib/audio/tts-providers';
import type { AgentInfo } from '@openmaic/generation';
import type { Action } from '@/lib/types/action';
import type { Scene, Stage } from '@/lib/types/stage';
import type { SceneOutline } from '@/lib/types/generation';
import type { GenerationLease, StepStart } from '@/lib/server/generation-jobs/contracts';
import {
  PipelineExecution,
  ExternalCallInterrupted,
  UnknownExternalOutcome,
  EXTERNAL_CALL_DEADLINES_MS,
  mapBounded,
} from '@/lib/server/generation-pipeline/execution';
import {
  runGenerationPipeline,
  type PipelineRepository,
  type PipelineServices,
} from '@/lib/server/generation-pipeline/pipeline';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const lease: GenerationLease = {
  jobId: 'job',
  stageId: 'stage',
  ownerId: 'owner',
  workerId: 'worker',
  leaseEpoch: 1,
  ownershipEpoch: 1,
  planRevision: 1,
  input: {
    version: 1,
    requirements: { requirement: 'A six scene course' },
    review: { mode: 'manual' },
  },
};
const outlines: SceneOutline[] = Array.from({ length: 6 }, (_, order) => ({
  id: `o${order}`,
  title: `Scene ${order}`,
  description: 'Lesson',
  type: 'quiz',
  keyPoints: ['one'],
  order,
}));
class MemoryRepository implements PipelineRepository {
  checkpoints = new Map<string, { status: string; result: unknown }>();
  scenes: Scene[] = [];
  plans = outlines;
  completeCount = 0;
  stageUpdates: Array<Partial<Stage>> = [];
  failures: Array<{
    stepKey: string;
    code: string;
    uncertain: boolean;
    errorSummary?: string;
    retryable?: boolean;
    retryAfterMs?: number;
  }> = [];
  warnings: string[] = [];
  async skipStepWithWarning(_lease: GenerationLease, input: { stepKey: string; code: string }) {
    if (this.checkpoints.get(input.stepKey)?.status === 'skipped') return;
    this.checkpoints.set(input.stepKey, { status: 'skipped', result: null });
    this.warnings.push(input.code);
  }
  async beginStep(_lease: GenerationLease, step: StepStart) {
    const previous = this.checkpoints.get(step.key);
    return {
      stepId: step.key,
      attemptId: step.key,
      requestKey: step.key,
      status: previous?.status ?? 'running',
      result: previous?.result,
    };
  }
  async commitCheckpoint(_lease: GenerationLease, data: { stepKey: string; result: unknown }) {
    this.checkpoints.set(data.stepKey, {
      status: 'succeeded',
      result: structuredClone(data.result),
    });
  }
  async failStep(
    _lease: GenerationLease,
    failure: {
      stepKey: string;
      code: string;
      uncertain: boolean;
      errorSummary?: string;
      retryable?: boolean;
      retryAfterMs?: number;
    },
  ) {
    this.failures.push(failure);
  }
  async getSnapshot() {
    return {
      outlines: this.plans,
      steps: [...this.checkpoints].map(([key, value]) => ({ key, ...value })),
    };
  }
  async savePlan(_lease: GenerationLease, plan: SceneOutline[]) {
    this.plans = plan;
  }
  async updateStage(_lease: GenerationLease, stage: Partial<Stage>) {
    this.stageUpdates.push(structuredClone(stage));
  }
  async publishScene(_lease: GenerationLease, _outlineId: string, scene: Scene) {
    this.scenes = [...this.scenes.filter((existing) => existing.id !== scene.id), scene];
  }
  async complete() {
    this.completeCount++;
  }
}
function setup(repo = new MemoryRepository()) {
  const execution = new PipelineExecution(repo, lease, new AbortController().signal, {
    run: (_kind, _group, _signal, work) => work(),
  });
  const counts = {
    content: 0,
    maxContent: 0,
    calls: [] as number[],
    actions: [] as number[],
    previous: [] as string[][],
  };
  const services: PipelineServices = {
    research: async () => '',
    plan: async () => ({ outlines, languageDirective: 'Chinese' }),
    agents: async (): Promise<AgentInfo[]> => [],
    content: async (outline) => {
      counts.content++;
      counts.calls.push(outline.order);
      counts.maxContent = Math.max(counts.maxContent, counts.content);
      await delay(outline.order === 0 ? 40 : 10);
      counts.content--;
      return { outline, content: { questions: [] } };
    },
    actions: async (checkpoint, _agents, _plan, previous) => {
      counts.actions.push(checkpoint.outline.order);
      counts.previous.push([...previous]);
      return [
        {
          id: `a${checkpoint.outline.order}`,
          type: 'speech',
          text: `Speech ${checkpoint.outline.order}`,
        },
      ] as Action[];
    },
    assemble: (checkpoint, actions, sceneId) => ({
      id: sceneId,
      outlineId: checkpoint.outline.id,
      stageId: 'stage',
      type: 'quiz',
      title: checkpoint.outline.title,
      order: checkpoint.outline.order,
      content: { type: 'quiz', questions: [] },
      actions,
      createdAt: 0,
      updatedAt: 0,
    }),
    media: async (scene) => scene,
    tts: async (scene) => scene,
  };
  return { repo, execution, services, counts };
}

describe('durable worker pipeline', () => {
  it.each(['rejected', 'failed'] as const)(
    'continues after confirmed optional media %s and reuses the skipped checkpoint',
    async (outcome) => {
      const { execution, repo, services } = setup();
      repo.plans = [outlines[0]!];
      const provider = vi.fn(async () => {
        throw new ConfirmedMediaFailure(outcome, 'Provider confirmed');
      });
      services.media = async (scene) => {
        for (let replay = 0; replay < 2; replay++) {
          expect(
            await execution.external('media:o0:image', {}, 'media', 'test', provider, true),
          ).toBeNull();
        }
        return scene;
      };
      expect(await runGenerationPipeline(repo, execution, services)).toBe('succeeded');
      expect(provider).toHaveBeenCalledTimes(1);
      expect(repo.warnings).toEqual([
        outcome === 'rejected' ? 'MEDIA_REQUEST_REJECTED' : 'MEDIA_TASK_FAILED',
      ]);
      expect(repo.scenes).toHaveLength(1);
      expect(repo.failures).toEqual([]);
    },
  );

  it.each([
    new Error('Network failed'),
    Object.assign(new Error('MEDIA_DOWNLOAD_FAILED'), { status: 429 }),
    new Error('Provider reported unknown task state'),
  ])('never converts an unconfirmed optional media error to a warning: %s', async (failure) => {
    const { execution, repo } = setup();
    await expect(
      execution.external(
        'media:o0:image',
        {},
        'media',
        'test',
        async () => {
          throw failure;
        },
        true,
      ),
    ).rejects.toBeInstanceOf(UnknownExternalOutcome);
    expect(repo.warnings).toEqual([]);
    expect(repo.failures[0]?.uncertain).toBe(true);
    expect(execution.signal.aborted).toBe(true);
  });

  it('does not downgrade required media extraction even for a confirmed failure', async () => {
    const { execution, repo } = setup();
    await expect(
      execution.external('materials:source', {}, 'media', 'test', async () => {
        throw new ConfirmedMediaFailure('failed', 'Extraction failed');
      }),
    ).rejects.toBeInstanceOf(UnknownExternalOutcome);
    expect(repo.warnings).toEqual([]);
  });

  it('keeps a lost optional warning commit uncertain', async () => {
    const { execution, repo } = setup();
    repo.skipStepWithWarning = async () => {
      throw new Error('Database offline');
    };
    await expect(
      execution.external(
        'media:o0:image',
        {},
        'media',
        'test',
        async () => {
          throw new ConfirmedMediaFailure('rejected', 'Rejected');
        },
        true,
      ),
    ).rejects.toBeInstanceOf(UnknownExternalOutcome);
    expect(repo.failures[0]?.uncertain).toBe(true);
  });
  it.each(['llm', 'tts', 'media'] as const)(
    'enforces the %s call deadline, aborts I/O, ignores late output and stops new calls',
    async (kind) => {
      vi.useFakeTimers();
      try {
        const { execution, repo } = setup();
        const started = vi.spyOn(repo, 'beginStep');
        let providerSignal: AbortSignal | undefined;
        let finish!: (value: string) => void;
        let calls = 0;
        const result = execution
          .external('timeout', {}, kind, 'provider', async (signal) => {
            calls++;
            providerSignal = signal;
            return new Promise<string>((resolve) => {
              finish = resolve;
            });
          })
          .catch((error) => error);
        await vi.advanceTimersByTimeAsync(0);
        expect(started).toHaveBeenCalledWith(
          lease,
          expect.objectContaining({ deadlineMs: EXTERNAL_CALL_DEADLINES_MS[kind] }),
        );
        await vi.advanceTimersByTimeAsync(EXTERNAL_CALL_DEADLINES_MS[kind] - 1);
        expect(providerSignal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(providerSignal?.aborted).toBe(true);
        expect(await result).toBeInstanceOf(UnknownExternalOutcome);
        expect(repo.failures).toEqual([
          {
            stepKey: 'timeout',
            code:
              kind === 'tts' ? 'TTS_RESULT_UNKNOWN_AFTER_TIMEOUT' : 'EXTERNAL_RESULT_UNKNOWN',
            uncertain: true,
            errorSummary:
              kind === 'tts'
                ? 'TTS provider did not return before the deadline; its result is unknown.'
                : 'External provider result is unknown.',
          },
        ]);
        finish('late provider output');
        await vi.advanceTimersByTimeAsync(0);
        expect(repo.checkpoints.has('timeout')).toBe(false);
        await expect(
          execution.external('next', {}, kind, 'provider', async () => {
            calls++;
            return 'should not execute';
          }),
        ).rejects.toBeInstanceOf(UnknownExternalOutcome);
        expect(calls).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('global cancellation stops even a provider adapter that ignores its AbortSignal', async () => {
    const repo = new MemoryRepository();
    const controller = new AbortController();
    const execution = new PipelineExecution(repo, lease, controller.signal, {
      run: (_kind, _group, _signal, work) => work(),
    });
    let accepted!: () => void;
    const began = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    const result = execution
      .external('ignores-abort', {}, 'llm', 'provider', async () => {
        accepted();
        return new Promise<string>(() => {});
      })
      .catch((error) => error);
    await began;
    controller.abort(new Error('GENERATION_CANCELLED'));
    expect(await result).toMatchObject({
      code: 'EXTERNAL_CALL_CANCELLED',
      requestOutcomeUnknown: true,
      safeSummary: 'External request was interrupted by cancellation after dispatch.',
    });
    expect(await result).toBeInstanceOf(ExternalCallInterrupted);
    expect(repo.checkpoints.size).toBe(0);
    expect(repo.failures).toEqual([]);
  });

  it('distinguishes worker lease loss and rejects a late provider result', async () => {
    const repo = new MemoryRepository();
    const controller = new AbortController();
    const execution = new PipelineExecution(repo, lease, controller.signal, {
      run: (_kind, _group, _signal, work) => work(),
    });
    let started!: () => void;
    let finish!: (value: string) => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const result = execution
      .external('lease-lost', {}, 'tts', 'provider', async () => {
        started();
        return new Promise<string>((resolve) => {
          finish = resolve;
        });
      })
      .catch((error) => error);

    await began;
    controller.abort(new Error('GENERATION_LEASE_LOST'));
    expect(await result).toMatchObject({
      code: 'WORKER_LEASE_LOST',
      requestOutcomeUnknown: true,
      safeSummary: 'External request was interrupted because the worker lease was lost.',
    });
    finish('late result');
    await Promise.resolve();
    expect(repo.checkpoints.has('lease-lost')).toBe(false);
    expect(repo.failures).toEqual([]);
  });
  it('overlaps at most two content calls with a two-outline lookahead and ordered committed speeches', async () => {
    const { repo, execution, services, counts } = setup();
    let releaseFirst!: () => void;
    let reportThird!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const thirdStarted = new Promise<void>((resolve) => {
      reportThird = resolve;
    });
    const content = services.content;
    services.content = async (outline, agents, plan) => {
      if (outline.order === 0) {
        counts.content++;
        counts.calls.push(0);
        counts.maxContent = Math.max(counts.maxContent, counts.content);
        await firstGate;
        counts.content--;
        return { outline, content: { questions: [] } };
      }
      const result = content(outline, agents, plan);
      if (outline.order === 2) reportThird();
      return result;
    };
    const run = runGenerationPipeline(repo, execution, services, 10);
    await thirdStarted;
    expect(counts.calls).toEqual([0, 1, 2]);
    releaseFirst();
    await run;
    expect(counts.maxContent).toBe(2);
    expect(counts.actions).toEqual([0, 1, 2, 3, 4, 5]);
    expect(counts.previous).toEqual([
      [],
      ['Speech 0'],
      ['Speech 1'],
      ['Speech 2'],
      ['Speech 3'],
      ['Speech 4'],
    ]);
    expect(repo.scenes).toHaveLength(6);
    expect(repo.completeCount).toBe(1);
  });

  it('reuses all committed generation after restart and publishes stable scene IDs', async () => {
    const fixture = setup();
    await runGenerationPipeline(fixture.repo, fixture.execution, fixture.services);
    const ids = fixture.repo.scenes.map((scene) => scene.id);
    const restarted = setup(fixture.repo);
    await runGenerationPipeline(restarted.repo, restarted.execution, restarted.services);
    expect(restarted.counts.calls).toEqual([]);
    expect(restarted.counts.actions).toEqual([]);
    expect(restarted.repo.scenes.map((scene) => scene.id)).toEqual(ids);
  });

  it('persists and reuses the versioned automatic roster decision after worker restart', async () => {
    const fixture = setup();
    fixture.repo.plans = [outlines[0]!];
    const frozenAgents: AgentInfo[] = [
      {
        id: 'gen-job-0',
        name: 'Teacher',
        role: 'teacher',
        persona: 'Explains and checks the core concept.',
      },
      {
        id: 'gen-job-1',
        name: 'Peer',
        role: 'student',
        persona: 'Attempts the task and compares reasoning.',
      },
    ];
    const decision = {
      kind: 'automatic-agent-decision' as const,
      version: 1 as const,
      strategyVersion: 'difficulty-v1' as const,
      outlineVersion: 1,
      difficulty: {
        level: 'introductory' as const,
        rationale: 'A single focused concept needs two distinct responsibilities.',
      },
      agents: frozenAgents,
    };
    fixture.services.agents = vi.fn(async () => decision);

    await runGenerationPipeline(fixture.repo, fixture.execution, fixture.services);

    expect(fixture.repo.checkpoints.get('agents')?.result).toEqual(decision);
    expect(fixture.repo.stageUpdates.at(-1)?.generatedAgentConfigs).toEqual(
      expect.arrayContaining(frozenAgents.map((agent) => expect.objectContaining(agent))),
    );

    const restarted = setup(fixture.repo);
    restarted.repo.plans = [outlines[0]!];
    restarted.services.agents = vi.fn(async () => {
      throw new Error('automatic roster must not be regenerated');
    });
    await runGenerationPipeline(restarted.repo, restarted.execution, restarted.services);

    expect(restarted.services.agents).not.toHaveBeenCalled();
    expect(restarted.repo.stageUpdates.at(-1)?.generatedAgentConfigs).toEqual(
      expect.arrayContaining(frozenAgents.map((agent) => expect.objectContaining(agent))),
    );
  });

  it('reads a legacy array roster checkpoint without regenerating it', async () => {
    const fixture = setup();
    fixture.repo.plans = [outlines[0]!];
    const legacyAgents: AgentInfo[] = [
      {
        id: 'legacy-teacher',
        name: 'Legacy Teacher',
        role: 'teacher',
        persona: 'Kept from the original checkpoint.',
      },
      {
        id: 'legacy-peer',
        name: 'Legacy Peer',
        role: 'student',
        persona: 'Kept from the original checkpoint.',
      },
    ];
    fixture.repo.checkpoints.set('agents', { status: 'succeeded', result: legacyAgents });
    fixture.services.agents = vi.fn(async () => {
      throw new Error('legacy roster must not be regenerated');
    });

    await runGenerationPipeline(fixture.repo, fixture.execution, fixture.services);

    expect(fixture.services.agents).not.toHaveBeenCalled();
    expect(fixture.repo.stageUpdates.at(-1)?.generatedAgentConfigs).toEqual(
      expect.arrayContaining(legacyAgents.map((agent) => expect.objectContaining(agent))),
    );
  });

  it('persists a plan then yields without agents or first-scene generation', async () => {
    const fixture = setup();
    fixture.repo.plans = [];
    expect(await runGenerationPipeline(fixture.repo, fixture.execution, fixture.services)).toBe(
      'awaiting_confirmation',
    );
    expect(fixture.counts.calls).toEqual([]);
    expect(fixture.repo.checkpoints.has('agents')).toBe(false);
    expect(fixture.repo.completeCount).toBe(0);
  });

  it('never marks a course complete after required TTS fails', async () => {
    const fixture = setup();
    fixture.services.tts = async () => {
      throw new Error('TTS failed');
    };
    await expect(
      runGenerationPipeline(fixture.repo, fixture.execution, fixture.services),
    ).rejects.toThrow('TTS failed');
    expect(fixture.repo.completeCount).toBe(0);
    expect(fixture.repo.scenes).toEqual([]);
    expect(fixture.repo.checkpoints.has('content:o1')).toBe(true);
  });

  it('records unknown external outcomes without automatic replay', async () => {
    const { execution, repo } = setup();
    let calls = 0;
    await expect(
      execution.external('paid-call', {}, 'llm', 'provider', async () => {
        calls++;
        throw new Error('timeout');
      }),
    ).rejects.toBeInstanceOf(UnknownExternalOutcome);
    expect(calls).toBe(1);
    expect(repo.failures).toEqual([
      {
        stepKey: 'paid-call',
        code: 'EXTERNAL_RESULT_UNKNOWN',
        uncertain: true,
        errorSummary: 'External provider result is unknown.',
      },
    ]);
  });

  it('records a request-before-send TTS configuration failure as certain', async () => {
    const { execution, repo } = setup();

    const error = await execution
      .external('tts:o0:a0', {}, 'tts', 'openai-tts', async (signal) =>
        generateTTS(
          {
            providerId: 'openai-tts',
            voice: 'alloy',
            signal,
          },
          'Hello',
        ),
      )
      .catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(TTSConfigurationError);
    expect(repo.failures).toEqual([
      {
        stepKey: 'tts:o0:a0',
        code: 'TTS_CONFIGURATION_INVALID',
        uncertain: false,
        errorSummary: 'TTS request was not sent because its configuration is invalid.',
      },
    ]);
  });

  it('records an explicit terminal TTS response without leaking provider details', async () => {
    const { execution, repo } = setup();
    const transport = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'invalid sk-secret-123' } }), {
        status: 400,
        statusText: 'Bad Request',
        headers: { 'content-type': 'application/json' },
      }),
    );
    try {
      const error = await execution
        .external('tts:o0:a0', {}, 'tts', 'openai-tts', async (signal) =>
          generateTTS(
            {
              providerId: 'openai-tts',
              apiKey: 'sk-secret-123',
              voice: 'alloy',
              signal,
            },
            'private narration',
          ),
        )
        .catch((failure: unknown) => failure);

      expect(error).toBeInstanceOf(TTSProviderTerminalError);
      expect(repo.failures).toEqual([
        {
          stepKey: 'tts:o0:a0',
          code: 'TTS_PROVIDER_TERMINAL_FAILURE',
          uncertain: false,
          errorSummary: 'TTS provider returned an explicit terminal failure.',
        },
      ]);
      expect(JSON.stringify(repo.failures)).not.toMatch(/secret|private narration|https?:\/\//i);
    } finally {
      transport.mockRestore();
    }
  });

  it('keeps a TTS timeout after dispatch uncertain and never schedules a blind retry', async () => {
    const { execution, repo } = setup();
    let calls = 0;

    const error = await execution
      .external('tts:o0:a0', {}, 'tts', 'minimax-tts', async () => {
        calls++;
        throw new TTSRequestTimeoutError('minimax-tts', 'contains private provider detail');
      })
      .catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      name: 'UnknownExternalOutcome',
      code: 'TTS_RESULT_UNKNOWN_AFTER_TIMEOUT',
    });
    expect(calls).toBe(1);
    expect(repo.failures).toEqual([
      {
        stepKey: 'tts:o0:a0',
        code: 'TTS_RESULT_UNKNOWN_AFTER_TIMEOUT',
        uncertain: true,
        errorSummary: 'TTS provider did not return before the deadline; its result is unknown.',
      },
    ]);
    expect(JSON.stringify(repo.failures)).not.toContain('private provider detail');
  });

  it('classifies TTS asset persistence failure after a received response without replay', async () => {
    const { execution, repo } = setup();
    let calls = 0;

    const error = await execution
      .external('tts:o0:a0', {}, 'tts', 'minimax-tts', async (_signal, lifecycle) => {
        calls++;
        lifecycle.markResponseReceived();
        throw new Error('disk path and provider payload must stay private');
      })
      .catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      name: 'UnknownExternalOutcome',
      code: 'TTS_RESULT_PERSIST_FAILED',
    });
    expect(calls).toBe(1);
    expect(repo.failures).toEqual([
      {
        stepKey: 'tts:o0:a0',
        code: 'TTS_RESULT_PERSIST_FAILED',
        uncertain: true,
        errorSummary: 'TTS response was received, but its audio asset could not be persisted.',
      },
    ]);
    expect(JSON.stringify(repo.failures)).not.toContain('disk path');
  });

  it('classifies a TTS checkpoint commit failure separately from asset persistence', async () => {
    const { execution, repo } = setup();
    repo.commitCheckpoint = async () => {
      throw new Error('database connection contains private host details');
    };

    const error = await execution
      .external('tts:o0:a0', {}, 'tts', 'minimax-tts', async () => 'asset-id')
      .catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      name: 'UnknownExternalOutcome',
      code: 'TTS_RESULT_COMMIT_FAILED',
    });
    expect(repo.failures).toEqual([
      {
        stepKey: 'tts:o0:a0',
        code: 'TTS_RESULT_COMMIT_FAILED',
        uncertain: true,
        errorSummary: 'TTS result was produced, but its checkpoint could not be committed.',
      },
    ]);
    expect(JSON.stringify(repo.failures)).not.toContain('private host');
  });

  it('bounds speech work independently and joins in-flight calls on failure', async () => {
    let active = 0;
    let max = 0;
    await expect(
      mapBounded([0, 1, 2, 3, 4], 2, async (index) => {
        active++;
        max = Math.max(max, active);
        await delay(5);
        active--;
        if (index === 0) throw new Error('failed');
      }),
    ).rejects.toThrow('failed');
    expect(max).toBe(2);
    expect(active).toBe(0);
  });

  it('improves the fixed simulated course by at least 20% without delaying first scene', async () => {
    vi.useFakeTimers();
    try {
      const measured = async (concurrency: number) => {
        const fixture = setup();
        fixture.services.content = async (outline) => {
          await delay(80);
          return { outline, content: { questions: [] } };
        };
        const actions = fixture.services.actions;
        fixture.services.actions = async (...args) => {
          await delay(20);
          return actions(...args);
        };
        const started = Date.now();
        let first = 0;
        const publish = fixture.repo.publishScene.bind(fixture.repo);
        fixture.repo.publishScene = async (...args) => {
          if (!first) first = Date.now() - started;
          return publish(...args);
        };
        const run = runGenerationPipeline(
          fixture.repo,
          fixture.execution,
          fixture.services,
          concurrency,
        );
        await vi.runAllTimersAsync();
        await run;
        return { total: Date.now() - started, first };
      };
      const serial = await measured(1);
      const parallel = await measured(2);
      expect(serial).toEqual({ total: 600, first: 100 });
      expect(parallel).toEqual({ total: 280, first: 100 });
      expect(parallel.total).toBeLessThanOrEqual(serial.total * 0.8);
      expect(parallel.first).toBeLessThanOrEqual(serial.first * 1.1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('schedules an explicit 429 using Retry-After, with no nested provider retry', async () => {
    const { execution, repo } = setup();
    let calls = 0;
    await expect(
      execution.external('limited', {}, 'llm', 'provider', async () => {
        calls++;
        throw { statusCode: 429, responseHeaders: { 'retry-after': '12' } };
      }),
    ).rejects.toThrow('PROVIDER_RATE_LIMITED');
    expect(calls).toBe(1);
    expect(repo.failures).toEqual([
      {
        stepKey: 'limited',
        code: 'PROVIDER_RATE_LIMITED',
        uncertain: false,
        errorSummary: 'Provider explicitly rejected the request with HTTP 429.',
        retryable: true,
        retryAfterMs: 12000,
      },
    ]);
  });
});
