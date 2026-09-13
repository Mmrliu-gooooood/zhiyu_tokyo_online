// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelSelection } from '@/lib/types/platform-default-models';

const mocks = vi.hoisted(() => ({
  state: {
    imageGenerationEnabled: false,
    videoGenerationEnabled: false,
    ttsEnabled: true,
    asrEnabled: false,
    imageProvidersConfig: {},
    videoProvidersConfig: {},
    asrProvidersConfig: {},
    ttsProvidersConfig: {} as Record<
      string,
      { customName?: string; modelId?: string; customModels?: Array<{ id: string; name: string }> }
    >,
    ttsProviderId: 'minimax-tts',
    ttsVoice: 'Chinese (Mandarin)_Warm_Bestie',
    ttsSelection: { source: 'platform', defaultId: 'zhiyu-default-tts' } as ModelSelection,
    platformDefaultsStatus: 'ready',
    platformDefaults: {
      version: 2,
      entries: [
        {
          capability: 'tts',
          defaultId: 'zhiyu-default-tts',
          displayName: 'MiniMax Speech 2.8 HD',
          providerName: 'MiniMax',
          modelId: 'speech-2.8-hd',
          available: true,
        },
      ],
    },
  },
}));

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
}));
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

import { MediaPopover } from '@/components/generation/media-popover';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('Home media TTS selection', () => {
  const platformCatalog = structuredClone(mocks.state.platformDefaults);
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    mocks.state.ttsSelection = { source: 'platform', defaultId: 'zhiyu-default-tts' };
    mocks.state.ttsProviderId = 'minimax-tts';
    mocks.state.ttsProvidersConfig = {};
    mocks.state.platformDefaults = structuredClone(platformCatalog);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ workflows: [] })),
    );
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  it('shows the selected custom model name without replacing it with the platform default', async () => {
    mocks.state.ttsSelection = {
      source: 'user',
      providerId: 'custom-tts-team',
      modelId: 'team-v2',
    };
    mocks.state.ttsProviderId = 'custom-tts-team';
    mocks.state.ttsProvidersConfig = {
      'custom-tts-team': {
        customName: 'Team Voice',
        modelId: 'team-v2',
        customModels: [{ id: 'team-v2', name: 'Team Voice Two' }],
      },
    };
    await act(async () => root.render(createElement(MediaPopover, { onSettingsOpen: vi.fn() })));
    await act(async () => container.querySelector('button')!.click());

    const popup = document.querySelector('[role="dialog"]');
    expect(popup?.textContent).toContain('Team Voice Two');
    expect(popup?.textContent).not.toContain('MiniMax Speech 2.8 HD');
    expect(mocks.state.ttsSelection).toEqual({
      source: 'user',
      providerId: 'custom-tts-team',
      modelId: 'team-v2',
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('shows the selected platform TTS model even without a legacy provider configuration', async () => {
    await act(async () => root.render(createElement(MediaPopover, { onSettingsOpen: vi.fn() })));
    await act(async () => container.querySelector('button')!.click());

    const popup = document.querySelector('[role="dialog"]');
    expect(popup).not.toBeNull();
    expect(popup?.textContent).toContain('media.ttsCapability');
    expect(popup?.textContent).toContain('MiniMax Speech 2.8 HD');
    expect(popup?.textContent).toContain('toolbar.advancedSettings');
  });

  it('does not claim a missing platform model is still loading after the catalog is ready', async () => {
    mocks.state.platformDefaults.entries = [];
    await act(async () => root.render(createElement(MediaPopover, { onSettingsOpen: vi.fn() })));
    await act(async () => container.querySelector('button')!.click());
    const popup = document.querySelector('[role="dialog"]');
    expect(popup?.textContent).toContain('settings.platformDefault.statuses.notConfigured');
    expect(popup?.textContent).not.toContain('settings.platformDefault.statuses.loading');
  });
});
