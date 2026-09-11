import { describe, expect, it } from 'vitest';
import { projectGenerationJobDisplay } from '@/lib/generation/job-display';
import { projectGenerationDisplayProgress } from '@/lib/server/generation-jobs/display-progress';

describe('projectGenerationJobDisplay', () => {
  it('projects the persisted 07 trigger and 08/09 unknown results without dropping checkpoints', () => {
    const outlines = Array.from({ length: 12 }, (_, index) => `scene_${index + 1}`);
    const progress = projectGenerationDisplayProgress({
      phase: 'failed',
      status: 'needs_attention',
      totalScenes: 12,
      lastErrorCode: 'EXTERNAL_RESULT_UNKNOWN',
      generationInput: {
        version: 1,
        requirements: { requirement: 'Test' },
        review: { mode: 'manual' },
      },
      steps: [
        ...outlines.slice(0, 6).flatMap((outlineId) => [
          {
            key: `content:${outlineId}`,
            kind: 'content',
            outlineId,
            status: 'succeeded',
            errorCode: null,
            startedAt: '2030-01-02T03:00:00.000Z',
          },
          {
            key: `actions:${outlineId}`,
            kind: 'actions',
            outlineId,
            status: 'succeeded',
            errorCode: null,
            startedAt: '2030-01-02T03:01:00.000Z',
          },
        ]),
        {
          key: 'actions:scene_7',
          kind: 'actions',
          outlineId: 'scene_7',
          status: 'retry_wait',
          errorCode: 'PROVIDER_REQUEST_NOT_SENT',
          startedAt: '2030-01-02T03:02:00.000Z',
        },
        {
          key: 'content:scene_8',
          kind: 'content',
          outlineId: 'scene_8',
          status: 'uncertain',
          errorCode: 'EXTERNAL_RESULT_UNKNOWN',
          startedAt: '2030-01-02T03:02:01.000Z',
        },
        {
          key: 'content:scene_9',
          kind: 'content',
          outlineId: 'scene_9',
          status: 'uncertain',
          errorCode: 'EXTERNAL_RESULT_UNKNOWN',
          startedAt: '2030-01-02T03:02:02.000Z',
        },
      ],
      scenes: outlines.map((outlineId, index) => ({
        outlineId,
        status:
          index < 6
            ? 'ready'
            : index === 6
              ? 'retry_wait'
              : index < 9
                ? 'needs_attention'
                : 'pending',
        actions: [],
      })),
    });

    expect(progress.published).toEqual({ completed: 6, total: 12 });
    expect(progress.actions.completed).toBe(6);
    expect(progress.issues).toEqual([
      {
        outlineId: 'scene_7',
        phase: 'actions',
        code: 'PROVIDER_REQUEST_NOT_SENT',
        state: 'retry_wait',
      },
      {
        outlineId: 'scene_8',
        phase: 'content',
        code: 'EXTERNAL_RESULT_UNKNOWN',
        state: 'unknown',
      },
      {
        outlineId: 'scene_9',
        phase: 'content',
        code: 'EXTERNAL_RESULT_UNKNOWN',
        state: 'unknown',
      },
    ]);
  });

  it('stops a needs-attention task and preserves both the trigger and unknown results', () => {
    expect(
      projectGenerationJobDisplay({
        status: 'needs_attention',
        retryAt: null,
        displayProgress: {
          phase: 'actions',
          content: { completed: 9, total: 12, active: 0 },
          actions: { completed: 6, total: 12, active: 0 },
          speech: { completed: 0, total: null, active: 0, skipped: 0 },
          published: { completed: 6, total: 12 },
          failedStep: {
            key: 'content:scene_8',
            phase: 'content',
            outlineId: 'scene_8',
            code: 'EXTERNAL_RESULT_UNKNOWN',
          },
          issues: [
            {
              outlineId: 'scene_7',
              phase: 'actions',
              code: 'PROVIDER_REQUEST_NOT_SENT',
              state: 'retry_wait',
            },
            {
              outlineId: 'scene_8',
              phase: 'content',
              code: 'EXTERNAL_RESULT_UNKNOWN',
              state: 'unknown',
            },
            {
              outlineId: 'scene_9',
              phase: 'content',
              code: 'EXTERNAL_RESULT_UNKNOWN',
              state: 'unknown',
            },
          ],
        },
        scenes: [
          { outlineId: 'scene_7', status: 'retry_wait' },
          { outlineId: 'scene_8', status: 'needs_attention' },
          { outlineId: 'scene_9', status: 'needs_attention' },
          { outlineId: 'scene_10', status: 'pending' },
        ],
      }),
    ).toEqual({
      status: 'needs_attention',
      executing: false,
      terminal: true,
      stopped: true,
      recovery: 'confirm_unknown',
      retryAt: null,
      affectedOutlineIds: ['scene_7', 'scene_8', 'scene_9', 'scene_10'],
      triggerIssues: [
        {
          outlineId: 'scene_7',
          phase: 'actions',
          code: 'PROVIDER_REQUEST_NOT_SENT',
          state: 'retry_wait',
        },
      ],
      unknownIssues: [
        {
          outlineId: 'scene_8',
          phase: 'content',
          code: 'EXTERNAL_RESULT_UNKNOWN',
          state: 'unknown',
        },
        {
          outlineId: 'scene_9',
          phase: 'content',
          code: 'EXTERNAL_RESULT_UNKNOWN',
          state: 'unknown',
        },
      ],
    });
  });

  it.each([
    ['queued', false, false, false, 'none'],
    ['running', true, false, false, 'none'],
    ['awaiting_confirmation', false, false, false, 'none'],
    ['retry_wait', false, false, false, 'none'],
    ['needs_attention', false, true, true, 'confirm_unknown'],
    ['failed', false, true, true, 'retry'],
    ['cancelled', false, true, false, 'none'],
    ['succeeded', false, true, false, 'none'],
  ] as const)(
    'projects %s without inventing execution or recovery',
    (status, executing, terminal, stopped, recovery) => {
      expect(projectGenerationJobDisplay({ status, retryAt: null, scenes: [] })).toMatchObject({
        status,
        executing,
        terminal,
        stopped,
        recovery,
      });
    },
  );

  it('keeps a real retry wait bounded by the server timestamp', () => {
    expect(
      projectGenerationJobDisplay({
        status: 'retry_wait',
        retryAt: '2030-01-02T03:04:05.000Z',
        scenes: [{ outlineId: 'scene_7', status: 'retry_wait' }],
      }),
    ).toMatchObject({
      executing: false,
      stopped: false,
      recovery: 'none',
      retryAt: '2030-01-02T03:04:05.000Z',
      affectedOutlineIds: [],
    });
  });
});
