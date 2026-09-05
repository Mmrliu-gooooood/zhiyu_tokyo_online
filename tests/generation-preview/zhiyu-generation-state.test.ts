import { describe, expect, it } from 'vitest';
import { projectZhiyuGenerationSteps } from '@/app/generation-preview/components/zhiyu-generation-state';

describe('projectZhiyuGenerationSteps', () => {
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
