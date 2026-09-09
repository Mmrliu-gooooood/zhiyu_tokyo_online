import { describe, expect, it } from 'vitest';
import { generationInputHash } from '@/lib/server/agent-runtime/generation-checkpoint';

describe('generation content checkpoint dependency', () => {
  it('covers roster, language, model, skill, and editable baseline', () => {
    const baseline = {
      stageId: 'stage', order: 1, title: 'T', type: 'slide', brief: 'B',
      agents: [{ id: 'teacher', persona: 'one' }],
      languageDirective: 'English',
      model: { modelString: 'vendor/a', thinkingConfig: { mode: 'disabled' } },
      skill: { id: 'lecture', constraints: { firstSceneType: 'slide' } },
      baseline: { elements: [{ id: 'old' }] },
    };
    const original = generationInputHash(baseline);
    for (const changed of [
      { agents: [{ id: 'teacher', persona: 'two' }] },
      { languageDirective: 'Chinese' },
      { model: { modelString: 'vendor/b' } },
      { skill: { id: 'quiz', constraints: {} } },
      { baseline: { elements: [{ id: 'new' }] } },
    ]) expect(generationInputHash({ ...baseline, ...changed })).not.toBe(original);
  });
});
