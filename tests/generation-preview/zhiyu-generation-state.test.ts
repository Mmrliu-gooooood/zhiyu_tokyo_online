import { describe, expect, it } from 'vitest';
import {
  projectBackgroundGenerationSnapshot,
  projectGenerationJobPresentation as projectGenerationJobPresentationKeys,
  projectZhiyuGenerationSteps,
} from '@/app/generation-preview/components/zhiyu-generation-state';

const zh: Record<string, string> = {
  'generation.statusOwnerWait': '构建课程中 · 等待你的上一项任务完成',
  'generation.statusOwnerWaitDesc': '当前账号已有一项重任务在执行。本任务会在执行位可用后继续。',
  'generation.statusSiteQueue': '构建课程中 · 排队等待',
  'generation.statusSiteQueueDesc': '正在等待全站执行位，不会因离开此页而停止。',
  'generation.statusParsingMaterials': '构建课程中 · 正在解析素材',
  'generation.statusParsingMaterialsDesc': '正在读取和整理课程素材。',
  'generation.statusGeneratingOutline': '构建课程中 · 正在生成大纲',
  'generation.statusGeneratingOutlineDesc': '正在构建课程结构。',
  'generation.statusGeneratingAgents': '构建课程中 · 正在生成课堂角色',
  'generation.statusGeneratingAgentsDesc': '正在准备课堂角色。',
  'generation.statusGeneratingScenes': '构建课程中 · 正在生成页面',
  'generation.statusGeneratingScenesProgress': '已完成 {{ready}} / {{total}} 页。',
  'generation.statusGeneratingSpeech': '构建课程中 · 正在合成语音',
  'generation.statusGeneratingSpeechDesc': '正在为已生成页面合成语音。',
  'generation.statusGeneratingMedia': '构建课程中 · 正在生成媒体',
  'generation.statusGeneratingMediaDesc': '正在处理页面所需媒体。',
  'generation.statusAwaitingOutlineReview': '构建课程中 · 等待你确认大纲',
  'generation.statusAwaitingOutlineReviewDesc': '大纲已保留，确认前不会占用重任务执行位。',
  'generation.statusOutlineAutoContinue': '构建课程中 · 大纲已完成',
  'generation.reviewOutlineAutoContinue': '如不审阅，大纲生成后会自动继续生成课程内容。',
  'generation.statusRetryWait': '构建课程中 · 模型繁忙，等待重试',
  'generation.statusRetryScheduledDesc': '模型服务繁忙，已安排自动重试。',
  'generation.statusCourseComplete': '课程已生成',
  'generation.statusCourseCompleteDesc': '课程内容已完成。',
  'generation.statusGenerationFailed': '生成失败',
  'generation.statusGenerationFailedDesc': '生成未完成，请查看原因后重试。',
  'generation.statusGenerationCancelled': '生成已取消',
  'generation.statusGenerationCancelledDesc': '已完成页面已保留；重新生成会创建新任务。',
  'generation.statusNeedsAttention': '需要确认处理',
  'generation.statusNeedsAttentionDesc': '任务需要你确认后才能继续处理。',
  'generation.statusSpeechNeedsAttention': '语音生成中断',
  'generation.statusSpeechNeedsAttentionDesc':
    '第 {{page}} 页语音生成中断，已有 {{completed}} / {{total}} 页内容已保留。语音服务的返回结果未确认。',
  'generation.statusCancelling': '构建课程中 · 正在取消',
  'generation.statusCancellingDesc': '正在请求停止尚未开始的工作；已完成页面会保留。',
  'generation.statusCancelFailed': '构建课程中 · 取消失败，可重试',
  'generation.statusCancelFailedDesc': '尚未确认任务已取消。你可以重试取消，或留在此页查看状态。',
  'generation.statusReconnecting': '构建课程中 · 连接中断，正在重连',
  'generation.statusReconnectingDesc': '暂时无法读取最新状态，后台任务不会因此被取消。',
  'generation.statusServiceUnavailable': '构建课程中 · 服务暂不可用',
  'generation.statusServiceUnavailableDesc': '生成服务暂时不可用，任务状态仍会继续同步。',
};

function projectGenerationJobPresentation(
  input: Parameters<typeof projectGenerationJobPresentationKeys>[0],
) {
  const projected = projectGenerationJobPresentationKeys(input);
  const interpolate = (value: string) =>
    Object.entries(projected.detailValues ?? {}).reduce(
      (text, [key, replacement]) => text.replace(`{{${key}}}`, String(replacement)),
      value,
    );
  return {
    title: zh[projected.titleKey],
    detail: interpolate(zh[projected.detailKey]),
    terminal: projected.terminal,
  };
}

describe('projectZhiyuGenerationSteps', () => {
  it('keeps content and finalization columns independently active during concurrent TTS', () => {
    const steps = projectZhiyuGenerationSteps({
      outlineReady: true,
      agentsReady: true,
      generatedSceneCount: 0,
      totalSceneCount: 2,
      mediaPending: false,
      jobStatus: 'running',
      displayProgress: {
        phase: 'tts',
        content: { completed: 1, total: 2, active: 1 },
        actions: { completed: 1, total: 2, active: 0 },
        speech: { completed: 0, total: null, active: 1, skipped: 0 },
        published: { completed: 0, total: 2 },
      },
    });

    expect(steps.map((step) => [step.id, step.status, step.detail])).toEqual([
      ['goal', 'done', undefined],
      ['outline', 'done', undefined],
      ['agents', 'done', undefined],
      ['scenes', 'active', '1 / 2'],
      ['media', 'active', '0 / 2'],
    ]);
  });

  it('follows the actions phase before the first complete scene is published', () => {
    const steps = projectZhiyuGenerationSteps({
      outlineReady: true,
      agentsReady: true,
      generatedSceneCount: 0,
      totalSceneCount: 10,
      phase: 'media-actions',
      mediaPending: true,
    });

    expect(steps.map((step) => [step.id, step.status])).toEqual([
      ['goal', 'done'],
      ['outline', 'done'],
      ['agents', 'done'],
      ['scenes', 'done'],
      ['media', 'active'],
    ]);
    expect(steps.find((step) => step.id === 'scenes')?.detail).toBeUndefined();
  });

  it('marks scene generation active after outline and agents are ready', () => {
    const steps = projectZhiyuGenerationSteps({
      outlineReady: true,
      agentsReady: true,
      generatedSceneCount: 3,
      totalSceneCount: 10,
      mediaPending: true,
      errorStage: null,
    });

    expect(steps.map((step) => [step.id, step.status])).toEqual([
      ['goal', 'done'],
      ['outline', 'done'],
      ['agents', 'done'],
      ['scenes', 'active'],
      ['media', 'pending'],
    ]);
    expect(steps.find((step) => step.id === 'scenes')?.detail).toBe('3 / 10');
  });

  it('keeps completed page content done when teaching actions fail', () => {
    const steps = projectZhiyuGenerationSteps({
      outlineReady: true,
      agentsReady: true,
      generatedSceneCount: 0,
      totalSceneCount: 10,
      phase: 'failed',
      mediaPending: false,
      errorStage: 'media',
    });

    expect(steps.find((step) => step.id === 'scenes')?.status).toBe('done');
    expect(steps.find((step) => step.id === 'media')?.status).toBe('error');
    expect(steps.filter((step) => step.status === 'active')).toHaveLength(0);
  });

  it('projects the real error stage without completing later steps', () => {
    const steps = projectZhiyuGenerationSteps({
      outlineReady: true,
      agentsReady: true,
      generatedSceneCount: 4,
      totalSceneCount: 10,
      mediaPending: true,
      errorStage: 'scenes',
    });

    expect(steps.find((step) => step.id === 'scenes')?.status).toBe('error');
    expect(steps.find((step) => step.id === 'media')?.status).toBe('pending');
  });

  it('only activates media after every real scene is available', () => {
    const steps = projectZhiyuGenerationSteps({
      outlineReady: true,
      agentsReady: true,
      generatedSceneCount: 2,
      totalSceneCount: 2,
      mediaPending: true,
      errorStage: null,
    });

    expect(steps.find((step) => step.id === 'scenes')?.status).toBe('done');
    expect(steps.find((step) => step.id === 'media')?.status).toBe('active');
  });

  it('keeps scenes pending while ready agents are waiting for generation to start', () => {
    const steps = projectZhiyuGenerationSteps({
      outlineReady: true,
      agentsReady: true,
      generatedSceneCount: 0,
      totalSceneCount: 2,
      scenesStarted: false,
      mediaPending: true,
      errorStage: null,
    });

    expect(steps.find((step) => step.id === 'agents')?.status).toBe('done');
    expect(steps.find((step) => step.id === 'scenes')?.status).toBe('pending');
  });
});

describe('projectBackgroundGenerationSnapshot', () => {
  it('keeps DTO phase and content progress stable across running and stopped snapshots', () => {
    const running = {
      status: 'running',
      phase: 'scene_content',
      readyScenes: 0,
      activeSteps: [{ kind: 'llm' }],
      displayProgress: {
        phase: 'tts' as const,
        content: { completed: 1, total: 2, active: 1 },
        actions: { completed: 1, total: 2, active: 0 },
        speech: { completed: 0, total: null, active: 1, skipped: 0 },
        published: { completed: 0, total: 2 },
      },
    };
    expect(projectBackgroundGenerationSnapshot(running)).toEqual({
      canonicalPhase: 'media-actions',
      stepId: 'actions',
      generatedContentCount: 1,
    });

    const stopped = {
      ...running,
      status: 'needs_attention',
      displayProgress: {
        ...running.displayProgress,
        phase: 'tts' as const,
        content: { completed: 1, total: 2, active: 0 },
        speech: { completed: 0, total: null, active: 0, skipped: 0 },
        failedStep: {
          key: 'tts:scene_1',
          phase: 'tts' as const,
          outlineId: 'scene_1',
          code: 'EXTERNAL_RESULT_UNKNOWN',
        },
      },
    };
    expect(projectBackgroundGenerationSnapshot(stopped)).toEqual({
      canonicalPhase: 'failed',
      stepId: 'actions',
      generatedContentCount: 1,
    });
  });
});

describe('projectGenerationJobPresentation', () => {
  it('replays content child calls from the unified display progress without returning to preparing', () => {
    const replay = {
      status: 'running',
      phase: 'scene_content',
      readyScenes: 0,
      totalScenes: 8,
      lastErrorCode: null,
      activeSteps: [{ kind: 'llm' }, { kind: 'content:scene_4' }],
      displayProgress: {
        phase: 'content' as const,
        content: { completed: 3, total: 8, active: 1 },
        actions: { completed: 0, total: 8, active: 0 },
        speech: { completed: 0, total: null, active: 0, skipped: 0 },
        published: { completed: 0, total: 8 },
      },
    };

    expect(projectGenerationJobPresentation({ job: replay })).toEqual({
      title: '构建课程中 · 正在生成页面',
      detail: '已完成 3 / 8 页。',
      terminal: false,
    });
  });

  it('keeps an uncertain speech failure in the fifth column and preserves completed content', () => {
    const replay = {
      status: 'needs_attention',
      phase: 'failed',
      readyScenes: 0,
      totalScenes: 2,
      lastErrorCode: 'EXTERNAL_RESULT_UNKNOWN',
      outlines: [{ id: 'scene_1' }, { id: 'scene_2' }],
      displayProgress: {
        phase: 'tts' as const,
        content: { completed: 1, total: 2, active: 0 },
        actions: { completed: 1, total: 2, active: 0 },
        speech: { completed: 0, total: null, active: 0, skipped: 0 },
        published: { completed: 0, total: 2 },
        failedStep: {
          key: 'tts:scene_1',
          phase: 'tts' as const,
          outlineId: 'scene_1',
          code: 'EXTERNAL_RESULT_UNKNOWN',
        },
      },
    };

    expect(projectGenerationJobPresentation({ job: replay })).toEqual({
      title: '语音生成中断',
      detail: '第 1 页语音生成中断，已有 1 / 2 页内容已保留。语音服务的返回结果未确认。',
      terminal: true,
    });

    const steps = projectZhiyuGenerationSteps({
      outlineReady: true,
      agentsReady: true,
      generatedSceneCount: 0,
      totalSceneCount: 2,
      mediaPending: false,
      jobStatus: replay.status,
      displayProgress: replay.displayProgress,
    });
    expect(steps.map((step) => [step.id, step.status, step.detail])).toEqual([
      ['goal', 'done', undefined],
      ['outline', 'done', undefined],
      ['agents', 'done', undefined],
      ['scenes', 'pending', '1 / 2'],
      ['media', 'error', '0 / 2'],
    ]);
  });

  it('does not present automatic outline continuation as required manual confirmation', () => {
    expect(
      projectGenerationJobPresentation({
        job: {
          status: 'awaiting_confirmation',
          phase: 'outlines',
          readyScenes: 0,
          totalScenes: 4,
          lastErrorCode: null,
          reviewHold: false,
          autoContinueAt: '2030-01-02T03:04:05.000Z',
        },
      }),
    ).toEqual({
      title: '构建课程中 · 大纲已完成',
      detail: '如不审阅，大纲生成后会自动继续生成课程内容。',
      terminal: false,
    });

    expect(
      projectGenerationJobPresentation({
        job: {
          status: 'awaiting_confirmation',
          phase: 'outlines',
          readyScenes: 0,
          totalScenes: 4,
          lastErrorCode: null,
          reviewHold: true,
          autoContinueAt: null,
        },
      }).title,
    ).toBe('构建课程中 · 等待你确认大纲');
  });

  it.each([
    ['QUEUE_WAIT_EXPIRED', 'generation.statusQueueExpired', 'generation.statusQueueExpiredDesc'],
    [
      'OUTLINE_REVIEW_EXPIRED',
      'generation.statusOutlineReviewExpired',
      'generation.statusOutlineReviewExpiredDesc',
    ],
  ])(
    'projects %s as a terminal result that requires a new submission',
    (code, titleKey, detailKey) => {
      expect(
        projectGenerationJobPresentationKeys({
          job: {
            status: 'failed',
            phase: 'failed',
            readyScenes: 0,
            totalScenes: 0,
            lastErrorCode: code,
          },
        }),
      ).toEqual({ titleKey, detailKey, terminal: true });
    },
  );
  it('distinguishes a personal execution-limit wait from the site queue', () => {
    expect(
      projectGenerationJobPresentation({
        job: {
          status: 'queued',
          phase: 'admission',
          queueReason: 'owner_limit',
          readyScenes: 0,
          totalScenes: 0,
          lastErrorCode: null,
        },
      }),
    ).toEqual({
      title: '构建课程中 · 等待你的上一项任务完成',
      detail: '当前账号已有一项重任务在执行。本任务会在执行位可用后继续。',
      terminal: false,
    });
  });

  it('shows a truthful site queue without inventing a rank or duration', () => {
    expect(
      projectGenerationJobPresentation({
        job: {
          status: 'queued',
          phase: 'queued',
          queueReason: 'site_limit',
          readyScenes: 0,
          totalScenes: 0,
          lastErrorCode: null,
        },
      }),
    ).toEqual({
      title: '构建课程中 · 排队等待',
      detail: '正在等待全站执行位，不会因离开此页而停止。',
      terminal: false,
    });
  });

  it.each([
    ['materials', '构建课程中 · 正在解析素材', '正在读取和整理课程素材。'],
    ['outline', '构建课程中 · 正在生成大纲', '正在构建课程结构。'],
    ['agents', '构建课程中 · 正在生成课堂角色', '正在准备课堂角色。'],
    ['scenes', '构建课程中 · 正在生成页面', '已完成 2 / 6 页。'],
    ['tts', '构建课程中 · 正在合成语音', '正在为已生成页面合成语音。'],
    ['media', '构建课程中 · 正在生成媒体', '正在处理页面所需媒体。'],
  ])('projects the server execution phase %s', (phase, title, detail) => {
    expect(
      projectGenerationJobPresentation({
        job: {
          status: 'running',
          phase,
          readyScenes: 2,
          totalScenes: 6,
          lastErrorCode: null,
        },
      }),
    ).toEqual({ title, detail, terminal: false });
  });

  it.each([
    [
      'awaiting_confirmation',
      '构建课程中 · 等待你确认大纲',
      '大纲已保留，确认前不会占用重任务执行位。',
      false,
    ],
    ['retry_wait', '构建课程中 · 模型繁忙，等待重试', '模型服务繁忙，已安排自动重试。', false],
    ['succeeded', '课程已生成', '课程内容已完成。', true],
    ['failed', '生成失败', '生成未完成，请查看原因后重试。', true],
    ['cancelled', '生成已取消', '已完成页面已保留；重新生成会创建新任务。', true],
    ['needs_attention', '需要确认处理', '任务需要你确认后才能继续处理。', true],
  ])('uses the lifecycle title for %s', (status, title, detail, terminal) => {
    expect(
      projectGenerationJobPresentation({
        job: {
          status,
          phase: 'outlines',
          readyScenes: 1,
          totalScenes: 4,
          lastErrorCode: null,
          retryAt: status === 'retry_wait' ? '2030-01-02T03:04:05.000Z' : null,
        },
      }),
    ).toEqual({ title, detail, terminal });
  });

  it('prioritizes cancellation and observation facts without inventing a terminal failure', () => {
    const job = {
      status: 'running',
      phase: 'scenes',
      readyScenes: 1,
      totalScenes: 4,
      lastErrorCode: null,
    };
    expect(projectGenerationJobPresentation({ job, cancelling: true }).title).toBe(
      '构建课程中 · 正在取消',
    );
    expect(projectGenerationJobPresentation({ job, cancelError: new Error('network') }).title).toBe(
      '构建课程中 · 取消失败，可重试',
    );
    expect(
      projectGenerationJobPresentation({ job, observationError: new Error('offline') }).title,
    ).toBe('构建课程中 · 连接中断，正在重连');
    expect(
      projectGenerationJobPresentation({
        job,
        observationError: Object.assign(new Error('GENERATION_NOT_READY'), {
          code: 'GENERATION_NOT_READY',
        }),
      }).title,
    ).toBe('构建课程中 · 服务暂不可用');
    expect(
      projectGenerationJobPresentation({ job: { ...job, phase: 'service_unavailable' } }),
    ).toEqual({
      title: '构建课程中 · 服务暂不可用',
      detail: '生成服务暂时不可用，任务状态仍会继续同步。',
      terminal: false,
    });
    expect(
      projectGenerationJobPresentation({
        job: { ...job, status: 'queued', queueReason: 'service_unavailable' },
      }),
    ).toEqual({
      title: '构建课程中 · 服务暂不可用',
      detail: '生成服务暂时不可用，任务状态仍会继续同步。',
      terminal: false,
    });
  });
});
