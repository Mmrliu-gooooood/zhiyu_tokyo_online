import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getState: vi.fn() }));
vi.mock('@/lib/store/settings', () => ({ useSettingsStore: { getState: mocks.getState } }));

import { getCurrentModelConfig, refreshPlatformModelConfig } from '@/lib/utils/model-config';

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

describe('refreshing a rejected platform submission', () => {
  const rejected = {
    source: 'platform' as const,
    defaultId: 'zhiyu-default-text' as const,
    revision: 'old',
  };

  it('reloads and rereads the selected platform model after catalog refresh', async () => {
    const fetchServerProviders = vi.fn(async () => {
      mocks.getState.mockReturnValue({ ...state, platformDefaultsStatus: 'ready' });
    });
    mocks.getState.mockReturnValue({ ...state, fetchServerProviders });

    await expect(refreshPlatformModelConfig(rejected)).resolves.toMatchObject({
      source: 'platform',
      defaultId: 'zhiyu-default-text',
      revision: 'text-r1',
    });
    expect(fetchServerProviders).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...state, platformDefaultsStatus: 'error' },
    {
      ...state,
      platformDefaultsStatus: 'ready',
      llmSelection: { source: 'user', providerId: 'openai', modelId: 'gpt-4o' },
    },
  ])(
    'does not retry a failed catalog load or a concurrent personal-model selection',
    async (refreshed) => {
      const fetchServerProviders = vi.fn(async () => mocks.getState.mockReturnValue(refreshed));
      mocks.getState.mockReturnValue({ ...state, fetchServerProviders });

      await expect(refreshPlatformModelConfig(rejected)).resolves.toBeUndefined();
    },
  );

  it('does not retry a connection revision conflict when the platform revision is current', async () => {
    const fetchServerProviders = vi.fn(async () => {});
    mocks.getState.mockReturnValue({
      ...state,
      platformDefaultsStatus: 'ready',
      fetchServerProviders,
    });

    await expect(
      refreshPlatformModelConfig({ ...rejected, revision: 'text-r1' }),
    ).resolves.toBeUndefined();
  });

  it('does not refresh personal models or continue an aborted submission', async () => {
    const fetchServerProviders = vi.fn(async () => {});
    mocks.getState.mockReturnValue({ ...state, fetchServerProviders });
    await expect(
      refreshPlatformModelConfig({ source: 'user', modelString: 'openai:gpt-4o' }),
    ).resolves.toBeUndefined();
    const controller = new AbortController();
    controller.abort();

    await expect(refreshPlatformModelConfig(rejected, controller.signal)).rejects.toThrow();
    expect(fetchServerProviders).not.toHaveBeenCalled();
  });
});
