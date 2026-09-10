import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GenerationLease, StepStart } from '@/lib/server/generation-jobs/contracts';
import { PipelineExecution } from '@/lib/server/generation-pipeline/execution';
import { GenerationMediaServices } from '@/lib/server/generation-pipeline/media';
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

describe('worker TTS persistence classification', () => {
  afterEach(() => vi.restoreAllMocks());

  it('marks a provider response before persisting audio bytes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { audio: '0102' }, extra_info: { audio_format: 'mp3' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
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
});
