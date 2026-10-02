// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderConfig } from '@/lib/types/provider';
import type { PlatformDefaultCatalogEntry } from '@/lib/types/platform-default-models';
import { useSettingsStore } from '@/lib/store/settings';

const translations: Record<string, string> = {
  'settings.defaultModel': '默认模型',
  'settings.platformDefault.titles.text': 'ZHIYU 默认文本模型',
  'settings.platformDefault.provider': '服务商',
  'settings.platformDefault.model': '模型',
  'settings.platformDefault.credentialsProvided': '平台提供，无需填写 API Key',
  'settings.platformDefault.status': '状态',
  'settings.platformDefault.separator': '：',
  'settings.platformDefault.statuses.loading': '正在加载目录',
  'settings.platformDefault.statuses.loadError': '目录加载失败',
  'settings.platformDefault.statuses.available': '可用',
  'settings.platformDefault.statuses.notConfigured': '平台尚未配置',
  'settings.platformDefault.statuses.disabled': '平台已停用',
  'settings.platformDefault.currentlyUsing': '当前正在使用此默认模型',
  'settings.platformDefault.useThisModel': '使用此模型',
};

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => translations[key] || key }),
}));

import { PlatformDefaultPanel } from '@/components/settings/platform-default-panel';
import { browseProviderDetails, ProviderList } from '@/components/settings/provider-list';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const textDefault: PlatformDefaultCatalogEntry = {
  defaultId: 'zhiyu-default-text',
  capability: 'text',
  providerId: 'deepseek',
  providerName: 'DeepSeek',
  modelId: 'deepseek-flash',
  displayName: 'DeepSeek V4.1 Flash',
  available: true,
  status: 'available',
  revision: 'revision-1',
  parameters: {},
};

describe('platform default settings UI', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.clearAllMocks();
  });

  it('renders the server catalog entry as read-only details and submits only from its button', () => {
    const onUse = vi.fn();
    act(() => {
      root.render(
        createElement(PlatformDefaultPanel, {
          capability: 'text',
          entry: textDefault,
          catalogStatus: 'ready',
          isSelected: false,
          onUse,
        }),
      );
    });

    expect(host.textContent).toContain('ZHIYU 默认文本模型');
    expect(host.textContent).toContain('服务商：DeepSeek');
    expect(host.textContent).toContain('模型：DeepSeek V4.1 Flash');
    expect(host.textContent).toContain('平台提供，无需填写 API Key');
    expect(host.querySelector('input')).toBeNull();
    expect(onUse).not.toHaveBeenCalled();

    const useButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === '使用此模型',
    );
    expect(useButton).toBeDefined();
    act(() => useButton?.click());
    expect(onUse).toHaveBeenCalledOnce();
  });

  it('keeps an unavailable catalog entry non-actionable', () => {
    act(() => {
      root.render(
        createElement(PlatformDefaultPanel, {
          capability: 'text',
          entry: { ...textDefault, available: false, status: 'disabled' },
          catalogStatus: 'ready',
          isSelected: false,
          onUse: vi.fn(),
        }),
      );
    });

    expect(host.textContent).toContain('平台已停用');
    expect(host.querySelector('button')?.disabled).toBe(true);
  });

  it('opens the default details without selecting a user provider', () => {
    const onSelectPlatformDefault = vi.fn();
    const onSelect = vi.fn();
    const provider = {
      id: 'deepseek',
      name: 'DeepSeek',
      type: 'openai',
      requiresApiKey: true,
      models: [],
    } as ProviderConfig;

    act(() => {
      root.render(
        createElement(ProviderList, {
          providers: [provider],
          selectedProviderId: 'deepseek',
          onSelect,
          onAddProvider: vi.fn(),
          onSelectPlatformDefault,
        }),
      );
    });

    const defaultEntry = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === '默认模型',
    );
    expect(defaultEntry).toBeDefined();
    expect(defaultEntry?.getAttribute('aria-pressed')).toBe('false');
    act(() => defaultEntry?.click());
    expect(onSelectPlatformDefault).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('browses a TTS provider detail without writing the persisted provider selection', () => {
    const before = useSettingsStore.getState().ttsProviderId;
    let browsed: string | undefined;
    const leaveDefault = vi.fn();

    browseProviderDetails(
      'minimax-tts',
      (providerId) => {
        browsed = providerId;
      },
      leaveDefault,
    );

    expect(browsed).toBe('minimax-tts');
    expect(leaveDefault).toHaveBeenCalledOnce();
    expect(useSettingsStore.getState().ttsProviderId).toBe(before);
  });

  it('wires the same browse-then-submit flow for all four capability sections', () => {
    const source = readFileSync(resolve(process.cwd(), 'components/settings/index.tsx'), 'utf8');

    for (const capability of ['text', 'image', 'video', 'tts'] as const) {
      expect(source).toContain(
        `onSelectPlatformDefault={() => showPlatformDefault('${capability}')}`,
      );
      expect(source).toContain(`capability="${capability}"`);
      expect(source).toContain(`setPlatformDefault('${capability}', entry.defaultId)`);
    }
  });
});
