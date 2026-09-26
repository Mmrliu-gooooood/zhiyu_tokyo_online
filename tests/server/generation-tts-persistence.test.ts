import { afterEach, describe, expect, it, vi } from 'vitest';

const usage = vi.hoisted(() => ({ record: vi.fn(async () => {}) }));
vi.mock('@/lib/server/usage-storage', () => ({ recordGenerationUsage: usage.record }));

import type { GenerationLease, StepStart } from '@/lib/server/generation-jobs/contracts';
import { PipelineExecution } from '@/lib/server/generation-pipeline/execution';
import {
  GenerationMediaServices,
  workerTTSUsageEventKey,
} from '@/lib/server/generation-pipeline/media';
import type { Scene } from '@/lib/types/stage';

const input = {
  version: 1,
  requirements: { requirement: 'test' },
  review: { mode: 'auto' },
  tts: {
    enabled: true,
    providerId: 'minimax-tts',
    modelId: 'speech-2.8-hd',
    voice: 'female-yujie',
  },
} as const;

const lease: GenerationLease = {
  jobId: 'job',
  stageId: 'stage',
  ownerId: 'owner',
  workerId: 'worker',
  leaseEpoch: 1,
  ownershipEpoch: 1,
  planRevision: 1,
  input,
};

function minimaxResponse() {
  return new Response(
    JSON.stringify({
      base_resp: { status_code: 0 },
      data: { audio: '0102' },
      extra_info: { audio_format: 'mp3' },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

const v1MediaConfig = {
  version: 1,
  ttsEnabled: true,
  tts: [
    {
      providerId: 'minimax-tts',
      modelId: 'speech-2.8-hd',
      voice: 'female-yujie',
      enabled: true,
      apiKey: 'key',
    },
  ],
} as never;

function runningRepository(receiptStatus: 'running' | 'succeeded' = 'running') {
  return {
    skipStepWithWarning: vi.fn(),
    beginStep: vi.fn(async (_current: GenerationLease, step: StepStart) => ({
      stepId: step.key,
      attemptId: step.key,
      requestKey: step.key,
      status: receiptStatus,
      ...(receiptStatus === 'succeeded' ? { result: 'asset:cached' } : {}),
    })),
    commitCheckpoint: vi.fn(),
    failStep: vi.fn(async () => {}),
  };
}

describe('worker TTS usage accounting', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    usage.record.mockClear();
  });

  it('records one owner/job-scoped character usage event per synthesized speech action', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => minimaxResponse());
    const repository = runningRepository();
    const execution = new PipelineExecution(repository, lease, new AbortController().signal, {
      run: (_kind, _group, _signal, work) => work(),
    });
    const assets = { read: vi.fn(), write: vi.fn(async () => 'asset:audio') };
    const media = new GenerationMediaServices(execution, input, assets, v1MediaConfig);
    const scene = {
      id: 'scene',
      stageId: 'stage',
      outlineId: 'one',
      order: 0,
      title: 'One',
      type: 'slide',
      content: { type: 'slide' },
      actions: [
        { id: 'a', type: 'speech', text: 'Hello' },
        { id: 'spotlight', type: 'spotlight', elementId: 'x' },
        { id: 'b', type: 'speech', text: '你好，同学们' },
      ],
    } as Scene;

    const result = await media.tts(scene);

    expect(result.actions?.filter((action) => action.type === 'speech')).toEqual([
      expect.objectContaining({ id: 'a', audioId: 'asset:audio' }),
      expect.objectContaining({ id: 'b', audioId: 'asset:audio' }),
    ]);
    expect(usage.record).toHaveBeenCalledTimes(2);
    expect(usage.record).toHaveBeenCalledWith({
      kind: 'tts',
      unit: 'character',
      providerId: 'minimax-tts',
      modelId: 'speech-2.8-hd',
      quantity: 5,
      ownerId: 'owner',
      jobId: 'job',
      eventKey: workerTTSUsageEventKey('job', 'tts:one:a'),
    });
    expect(usage.record).toHaveBeenCalledWith(
      expect.objectContaining({
        quantity: '你好，同学们'.length,
        eventKey: 'generation:job:tts:one:b',
      }),
    );
  });

  it('does not re-record usage for a step whose checkpoint already succeeded', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const execution = new PipelineExecution(
      runningRepository('succeeded'),
      lease,
      new AbortController().signal,
      { run: (_kind, _group, _signal, work) => work() },
    );
    const assets = { read: vi.fn(), write: vi.fn() };
    const media = new GenerationMediaServices(execution, input, assets, v1MediaConfig);
    const scene = {
      id: 'scene',
      stageId: 'stage',
      outlineId: 'one',
      order: 0,
      title: 'One',
      type: 'slide',
      content: { type: 'slide' },
      actions: [{ id: 'a', type: 'speech', text: 'Hello' }],
    } as Scene;

    const result = await media.tts(scene);

    expect(result.actions?.[0]).toMatchObject({ audioId: 'asset:cached' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(usage.record).not.toHaveBeenCalled();
  });

  it('keeps the same event key when a step is re-run after a persist failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => minimaxResponse());
    const scene = {
      id: 'scene',
      stageId: 'stage',
      outlineId: 'one',
      order: 0,
      title: 'One',
      type: 'slide',
      content: { type: 'slide' },
      actions: [{ id: 'a', type: 'speech', text: 'Hello' }],
    } as Scene;
    const failing = new GenerationMediaServices(
      new PipelineExecution(runningRepository(), lease, new AbortController().signal, {
        run: (_kind, _group, _signal, work) => work(),
      }),
      input,
      {
        read: vi.fn(),
        write: vi.fn(async () => {
          throw new Error('storage down');
        }),
      },
      v1MediaConfig,
    );
    await expect(failing.tts(scene)).rejects.toMatchObject({ code: 'TTS_RESULT_PERSIST_FAILED' });
    const retry = new GenerationMediaServices(
      new PipelineExecution(runningRepository(), lease, new AbortController().signal, {
        run: (_kind, _group, _signal, work) => work(),
      }),
      input,
      { read: vi.fn(), write: vi.fn(async () => 'asset:audio') },
      v1MediaConfig,
    );
    await retry.tts(scene);

    const keys = usage.record.mock.calls.map((call) => (call as unknown[])[0]);
    expect(keys).toHaveLength(2);
    expect(new Set(keys.map((entry) => (entry as { eventKey: string }).eventKey))).toEqual(
      new Set(['generation:job:tts:one:a']),
    );
  });

  it('does not record usage when the provider returns an error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ base_resp: { status_code: 1004, status_msg: 'auth' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const media = new GenerationMediaServices(
      new PipelineExecution(runningRepository(), lease, new AbortController().signal, {
        run: (_kind, _group, _signal, work) => work(),
      }),
      input,
      { read: vi.fn(), write: vi.fn(async () => 'asset:audio') },
      v1MediaConfig,
    );
    const scene = {
      id: 'scene',
      stageId: 'stage',
      outlineId: 'one',
      order: 0,
      title: 'One',
      type: 'slide',
      content: { type: 'slide' },
      actions: [{ id: 'a', type: 'speech', text: 'Hello' }],
    } as Scene;

    await expect(media.tts(scene)).rejects.toBeDefined();
    expect(usage.record).not.toHaveBeenCalled();
  });
});

describe('worker TTS persistence classification', () => {
  afterEach(() => vi.restoreAllMocks());

  it('marks a provider response before persisting audio bytes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          base_resp: { status_code: 0 },
          data: { audio: '0102' },
          extra_info: { audio_format: 'mp3' },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    const failures: unknown[] = [];
    const repository = {
      skipStepWithWarning: vi.fn(),
      beginStep: vi.fn(async (_current: GenerationLease, step: StepStart) => ({
        stepId: step.key,
        attemptId: step.key,
        requestKey: step.key,
        status: 'running' as const,
      })),
      commitCheckpoint: vi.fn(),
      failStep: vi.fn(async (_current: GenerationLease, failure: unknown) => {
        failures.push(failure);
      }),
    };
    const execution = new PipelineExecution(repository, lease, new AbortController().signal, {
      run: (_kind, _group, _signal, work) => work(),
    });
    const assets = {
      read: vi.fn(),
      write: vi.fn(async () => {
        throw new Error('private storage failure');
      }),
    };
    const media = new GenerationMediaServices(execution, input, assets, {
      version: 1,
      ttsEnabled: true,
      tts: [
        {
          providerId: 'minimax-tts',
          modelId: 'speech-2.8-hd',
          voice: 'female-yujie',
          enabled: true,
          apiKey: 'key',
        },
      ],
    } as never);
    const scene = {
      id: 'scene',
      stageId: 'stage',
      outlineId: 'one',
      order: 0,
      title: 'One',
      type: 'slide',
      content: { type: 'slide' },
      actions: [{ id: 'speech', type: 'speech', text: 'Hello' }],
    } as Scene;

    await expect(media.tts(scene)).rejects.toMatchObject({
      code: 'TTS_RESULT_PERSIST_FAILED',
    });
    expect(failures).toEqual([
      {
        stepKey: 'tts:one:speech',
        code: 'TTS_RESULT_PERSIST_FAILED',
        uncertain: true,
        errorSummary: 'TTS response was received, but its audio asset could not be persisted.',
      },
    ]);
    expect(repository.commitCheckpoint).not.toHaveBeenCalled();
  });

  it.each([undefined, 'home', 'pro'] as const)(
    'preserves a v2 role voice and gates pre-send retry for source %s',
    async (sourceKind) => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            base_resp: { status_code: 0 },
            data: { audio: '0102' },
            extra_info: { audio_format: 'mp3' },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      );
      const repository = {
        skipStepWithWarning: vi.fn(),
        beginStep: vi.fn(async (_current: GenerationLease, step: StepStart) => ({
          stepId: step.key,
          attemptId: step.key,
          requestKey: step.key,
          status: 'running' as const,
        })),
        commitCheckpoint: vi.fn(),
        failStep: vi.fn(),
      };
      const execution = new PipelineExecution(repository, lease, new AbortController().signal, {
        run: (_kind, _group, _signal, work) => work(),
      });
      const assets = { read: vi.fn(), write: vi.fn(async () => 'asset:audio') };
      const v2Input = {
        ...input,
        ...(sourceKind ? { source: { kind: sourceKind } } : {}),
        tts: {
          ...input.tts,
          agentVoiceOverrides: {
            teacher: {
              providerId: 'minimax-tts',
              modelId: 'speech-2.8-hd',
              voiceId: 'male-qn-jingying',
            },
          },
        },
      } as const;
      const media = new GenerationMediaServices(execution, v2Input, assets, {
        version: 2,
        ttsEnabled: true,
        ttsProviders: [
          {
            providerId: 'minimax-tts',
            modelId: 'speech-2.8-hd',
            enabled: true,
            requiresApiKey: true,
            apiKey: 'key',
            baseUrl: '',
          },
        ],
        ttsDefault: {
          providerId: 'minimax-tts',
          modelId: 'speech-2.8-hd',
          voiceId: 'female-yujie',
        },
        ttsVoiceDirectory: [
          {
            providerId: 'minimax-tts',
            modelId: 'speech-2.8-hd',
            voiceIds: ['female-yujie', 'male-qn-jingying'],
          },
        ],
      });
      const scene = {
        id: 'scene',
        stageId: 'stage',
        outlineId: 'one',
        order: 0,
        title: 'One',
        type: 'slide',
        content: { type: 'slide' },
        actions: [{ id: 'speech', type: 'speech', text: 'Hello' }],
      } as Scene;

      const result = await media.tts(scene, [
        { id: 'teacher', name: 'Teacher', role: 'teacher', persona: 'Explains' },
      ]);

      expect(result.actions?.[0]).toMatchObject({ audioId: 'asset:audio' });
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(String(fetchSpy.mock.calls[0]?.[1]?.body)).toContain('male-qn-jingying');
      expect(fetchSpy.mock.calls[0]?.[1]?.redirect).toBe(
        sourceKind === 'pro' ? 'error' : undefined,
      );
    },
  );
});
