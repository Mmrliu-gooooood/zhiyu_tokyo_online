/**
 * Thinking rules settled by the P2-5 golden replay (see
 * characterization/golden-allowlist.json for the legacy differences).
 */
import { describe, expect, it } from 'vitest';
import { buildPayloadPatcher, planThinking } from '@/lib/model-gateway/runtime/thinking';
import type { ModelBinding, PiModel, ThinkingCapability } from '@/lib/model-gateway/types';

function plan(capability: ThinkingCapability, thinking: ModelBinding['thinking']) {
  return planThinking({
    model: { api: 'openai-completions', reasoning: true } as PiModel,
    thinking,
    capabilities: {
      tools: true,
      vision: false,
      reasoning: true,
      contextWindow: 128_000,
      knownModel: true,
      thinking: capability,
    },
  });
}

describe('thinking rules (P2-5)', () => {
  it("mode:'enabled' never means off when the default effort is none", () => {
    const capability: ThinkingCapability = {
      control: 'effort',
      effortValues: ['none', 'low', 'high'],
      defaultEffort: 'none',
      toggleable: true,
    };
    expect(plan(capability, { mode: 'enabled' }).reasoning).toBe('low');
    // An explicit effort:'none' is still off.
    expect(plan(capability, { mode: 'enabled', effort: 'none' }).reasoning).toBeUndefined();
  });

  it("a budget equal to the capability's disable value turns thinking off", () => {
    const capability: ThinkingCapability = {
      control: 'toggle-budget',
      budgetRange: { min: 0, max: 24_576, disableValue: 0 },
      toggleable: true,
    };
    const off = plan(capability, { mode: 'enabled', budgetTokens: 0 });
    expect(off.reasoning).toBeUndefined();
    expect(off.patches).not.toContain('provider-default-thinking');
    expect(plan(capability, { mode: 'enabled', budgetTokens: 2048 })).toMatchObject({
      reasoning: 'medium',
      thinkingBudgets: { medium: 2048 },
    });
  });

  const claude5 = {
    api: 'anthropic-messages',
    thinkingLevelMap: {},
    compat: { supportsMidConvoEffort: true },
  } as PiModel;
  const payload = () => ({
    output_config: { effort: 'high' },
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'system', content: [], output_config: { effort: 'high' } },
    ],
  });

  it('keeps the Claude 5 mid-conversation effort entry equal to the requested effort', () => {
    const patch = buildPayloadPatcher(['anthropic-managed-effort'], {
      config: { effort: 'low' },
      level: 'low',
      model: claude5,
    })!;
    const out = patch(payload()) as ReturnType<typeof payload>;
    expect(out.output_config.effort).toBe('low');
    expect(out.messages.at(-1)).toEqual({
      role: 'system',
      content: [],
      output_config: { effort: 'low' },
    });
  });

  it('drops Claude 5 effort control entries for the provider default', () => {
    const patch = buildPayloadPatcher(['provider-default-thinking'], { config: undefined })!;
    const out = patch(payload()) as ReturnType<typeof payload>;
    expect(out.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(out).not.toHaveProperty('output_config');
  });

  it('strips Google and Bedrock caps and Google thinking with the generic patches', () => {
    const omit = buildPayloadPatcher(['omit-max-tokens', 'omit-thinking-budget'], {
      config: undefined,
    })!;
    expect(
      omit({
        config: {
          maxOutputTokens: 9,
          thinkingConfig: { includeThoughts: true, thinkingBudget: 8 },
        },
        inferenceConfig: { maxTokens: 9, temperature: 0 },
        chat_template_kwargs: { enable_thinking: true, thinking_budget: 7 },
      }),
    ).toEqual({
      config: { thinkingConfig: { includeThoughts: true } },
      inferenceConfig: { temperature: 0 },
      chat_template_kwargs: { enable_thinking: true },
    });
  });
});
