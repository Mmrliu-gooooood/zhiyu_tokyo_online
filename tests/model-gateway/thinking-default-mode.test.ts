import { describe, expect, it } from 'vitest';
import { planThinking } from '@/lib/model-gateway/runtime/thinking';
import type { ThinkingCapability, ThinkingConfig } from '@/lib/types/provider';
import { piModel } from './helpers';

/**
 * `mode:'default'` is the explicit spelling of "no thinking intent": it means
 * the provider's own default, exactly like an absent config. Any other field
 * sent with it (enabled / effort / budget) is still honoured.
 */
const capability: ThinkingCapability = {
  control: 'effort',
  effortValues: ['none', 'low', 'medium', 'high'],
  defaultEffort: 'high',
  toggleable: true,
};

async function plan(thinking?: ThinkingConfig) {
  const model = await piModel('deepseek', 'deepseek-flash');
  return planThinking({
    model,
    thinking,
    capabilities: {
      tools: true,
      vision: false,
      reasoning: true,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxTokens,
      knownModel: true,
      thinking: capability,
    },
  });
}

describe("thinking mode:'default'", () => {
  it('equals no config: provider default, no thinking fields', async () => {
    const none = await plan(undefined);
    const byDefault = await plan({ mode: 'default' });
    expect(byDefault.reasoning).toBeUndefined();
    expect(byDefault.patches).toEqual(none.patches);
    expect(byDefault.patches).toContain('provider-default-thinking');
  });

  it.each([
    [{ mode: 'default', effort: 'low' }, 'low'],
    [{ mode: 'default', enabled: true }, 'high'],
  ] satisfies [ThinkingConfig, string][])(
    'still honours explicit fields: %o',
    async (config, level) => {
      const result = await plan(config);
      expect(result.reasoning).toBe(level);
      expect(result.patches).not.toContain('provider-default-thinking');
    },
  );

  it('still honours an explicit disable', async () => {
    const result = await plan({ mode: 'default', enabled: false });
    expect(result.reasoning).toBeUndefined();
    expect(result.patches).not.toContain('provider-default-thinking');
  });
});

describe('LLM_THINKING_DISABLED (global kill switch)', () => {
  it('turns thinking off only when the call carries no config', async () => {
    process.env.LLM_THINKING_DISABLED = 'true';
    try {
      const unset = await plan(undefined);
      expect(unset.effective).toEqual({ mode: 'disabled', enabled: false });
      expect(unset.reasoning).toBeUndefined();
      expect(unset.patches).not.toContain('provider-default-thinking');

      // An explicit per-call config still wins over the global switch.
      const explicit = await plan({ mode: 'enabled', effort: 'low' });
      expect(explicit.reasoning).toBe('low');
    } finally {
      delete process.env.LLM_THINKING_DISABLED;
    }
  });
});
