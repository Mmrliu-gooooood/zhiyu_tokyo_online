import { describe, expect, it } from 'vitest';
import { projectZhiyuGenerationSteps } from '@/app/generation-preview/components/zhiyu-generation-state';

describe('projectZhiyuGenerationSteps', () => {
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
