import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getState: vi.fn() }));
vi.mock('@/lib/store/settings', () => ({ useSettingsStore: { getState: mocks.getState } }));

import { getCurrentModelConfig } from '@/lib/utils/model-config';

const state = {
  providerId: 'deepseek',
  modelId: 'deepseek-flash',
  providersConfig: {},
  thinkingConfigs: {},
  llmSelection: { source: 'platform', defaultId: 'zhiyu-default-text' },
  platformDefaults: {
    version: 2,
    entries: [
      {
        defaultId: 'zhiyu-default-text',
        capability: 'text',
        providerId: 'deepseek',
        providerName: 'DeepSeek',
        modelId: 'deepseek-flash',
        displayName: 'DeepSeek Flash',
        available: true,
        status: 'available',
        revision: 'text-r1',
        parameters: {},
        defaultThinkingConfig: { mode: 'disabled', effort: 'none' },
      },
    ],
  },
};

describe('platform model client configuration', () => {
  beforeEach(() => mocks.getState.mockReturnValue(state));

  it('uses the platform default thinking policy without exposing connection fields', () => {
    expect(getCurrentModelConfig()).toMatchObject({
      source: 'platform',
      defaultId: 'zhiyu-default-text',
      revision: 'text-r1',
      modelString: '',
      apiKey: '',
      baseUrl: '',
      thinkingConfig: { mode: 'disabled', effort: 'none' },
    });
  });

  it('preserves an intentional supported user preference for the platform model', () => {
    mocks.getState.mockReturnValue({
      ...state,
      thinkingConfigs: {
        'deepseek:deepseek-flash': { mode: 'enabled', effort: 'high' },
      },
    });

    expect(getCurrentModelConfig().thinkingConfig).toEqual({ mode: 'enabled', effort: 'high' });
  });

  it.each([{}, { mode: 'default' }])(
    'does not let an empty/default preference override the platform policy: %j',
    (saved) => {
      mocks.getState.mockReturnValue({
        ...state,
        thinkingConfigs: { 'deepseek:deepseek-flash': saved },
      });

      expect(getCurrentModelConfig().thinkingConfig).toEqual({ mode: 'disabled', effort: 'none' });
    },
  );
});
