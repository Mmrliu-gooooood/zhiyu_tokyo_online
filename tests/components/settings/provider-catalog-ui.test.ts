// @vitest-environment jsdom
/**
 * P5-2: the settings provider list over the full catalog — grouping, search,
 * visibility of operator-only / sign-in-only providers — the provider panel's
 * fixed endpoints and endpoint values, and the custom-provider protocols.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

import { groupProviders, ProviderList } from '@/components/settings/provider-list';
import { ProviderConfigPanel, previewEndpoint } from '@/components/settings/provider-config-panel';
import { AddProviderDialog, type NewProviderData } from '@/components/settings/add-provider-dialog';
import {
  CLIENT_PROVIDERS,
  isProviderListed,
  oauthSignInAvailable,
} from '@/lib/model-gateway/catalog/client-catalog';
import { CUSTOM_PROVIDER_APIS } from '@/lib/model-gateway/catalog/descriptors';
import type { ProviderId } from '@/lib/types/provider';
import type { ProvidersConfig } from '@/lib/types/settings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function listEntry(id: string) {
  const provider = CLIENT_PROVIDERS[id];
  return {
    id: id as ProviderId,
    name: provider?.name ?? id,
    type: provider?.type ?? ('openai' as const),
    requiresApiKey: true,
    models: [],
    group: provider?.group ?? ('custom' as const),
  };
}

describe('provider list visibility (D14, P2-6)', () => {
  it('lists API-key providers, hides operator-only and sign-in-only ones until enabled', () => {
    expect(isProviderListed('groq', {})).toBe(true);
    expect(isProviderListed('custom-1', {})).toBe(true);
    expect(isProviderListed('bedrock', {})).toBe(false);
    expect(isProviderListed('bedrock', { serverConfigured: true })).toBe(true);
    expect(isProviderListed('google-vertex', {})).toBe(false);
    expect(isProviderListed('github-copilot', { oauthProviders: [] })).toBe(false);
    expect(isProviderListed('github-copilot', { oauthProviders: ['github-copilot'] })).toBe(true);
    // Sign-in gating never hides a provider's API-key method.
    expect(isProviderListed('openai', { oauthProviders: [] })).toBe(true);
    expect(oauthSignInAvailable('openai', [])).toBe(false);
    expect(oauthSignInAvailable('openai', ['openai'])).toBe(true);
    expect(oauthSignInAvailable('groq', ['groq'])).toBe(false);
  });

  it('groups in display order and searches by name or id', () => {
    const entries = ['custom-1', 'groq', 'deepseek', 'zai-coding', 'ollama', 'kimi'].map(listEntry);
    const name = (entry: { name: string }) => entry.name;
    expect(groupProviders(entries, '', name).map((group) => group.group)).toEqual([
      'official',
      'china',
      'coding-plan',
      'local',
      'custom',
    ]);
    expect(
      groupProviders(entries, 'GROQ', name).flatMap((group) => group.providers.map((p) => p.id)),
    ).toEqual(['groq']);
    expect(groupProviders(entries, 'no-such-provider', name)).toEqual([]);
  });

  it('renders group headings and filters on search input', () => {
    const providers = ['groq', 'deepseek', 'zai-coding'].map(listEntry);
    act(() =>
      root.render(
        createElement(ProviderList, {
          providers,
          selectedProviderId: 'groq' as ProviderId,
          onSelect: vi.fn(),
          onAddProvider: vi.fn(),
        }),
      ),
    );
    expect(container.querySelectorAll('[data-provider-group]').length).toBe(2);
    expect(container.textContent).toContain('settings.providerGroups.coding-plan');

    const input = container.querySelector('input[type="search"]') as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'zai');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const buttons = [...container.querySelectorAll('[data-provider-group] button')];
    expect(buttons.map((button) => button.textContent)).toEqual(['Z.AI Coding Plan']);
  });
});

describe('provider panel', () => {
  function renderPanel(id: string, overrides: Partial<ProvidersConfig[ProviderId]> = {}) {
    const provider = CLIENT_PROVIDERS[id]!;
    const providersConfig = {
      [id]: {
        apiKey: 'k',
        baseUrl: '',
        models: provider.models,
        name: provider.name,
        type: provider.type,
        requiresApiKey: true,
        isBuiltIn: true,
        ...overrides,
      },
    } as unknown as ProvidersConfig;
    const onEndpointParamsChange = vi.fn();
    act(() =>
      root.render(
        createElement(ProviderConfigPanel, {
          provider: { ...provider, id: id as ProviderId },
          catalog: provider,
          initialApiKey: 'k',
          initialBaseUrl: overrides.baseUrl ?? '',
          initialRequiresApiKey: true,
          initialEndpointParams: overrides.endpointParams,
          providersConfig,
          onConfigChange: vi.fn(),
          onEndpointParamsChange,
          onSave: vi.fn(),
          onEditModel: vi.fn(),
          onDeleteModel: vi.fn(),
          onAddModel: vi.fn(),
          isBuiltIn: true,
        }),
      ),
    );
    return { onEndpointParamsChange };
  }

  it('a fixed-endpoint provider shows its endpoint instead of a Base URL input', () => {
    renderPanel('groq');
    expect(container.querySelector('input[name="llm-base-url-groq"]')).toBeNull();
    expect(container.textContent).toContain('https://api.groq.com/openai/v1/chat/completions');
    expect(container.textContent).toContain('settings.fixedEndpointHint');
    // R1: no sign-in tab anywhere.
    expect(container.querySelector('[role="tablist"]')).toBeNull();
  });

  it('a stale custom Base URL on a fixed-endpoint provider is flagged', () => {
    renderPanel('google', { baseUrl: 'https://relay.example.com' });
    expect(container.textContent).toContain('settings.customBaseUrlNotAllowed');
  });

  it('declared endpoint values get inputs and fill the endpoint preview', () => {
    const { onEndpointParamsChange } = renderPanel('cloudflare-ai-gateway', {
      endpointParams: { CLOUDFLARE_ACCOUNT_ID: 'acct' },
    });
    expect(container.textContent).toContain('settings.endpointParamLabels.CLOUDFLARE_GATEWAY_ID');
    expect(container.textContent).toContain(
      'https://gateway.ai.cloudflare.com/v1/acct/{CLOUDFLARE_GATEWAY_ID}/anthropic/messages',
    );
    const input = container.querySelector(
      '#llm-endpoint-cloudflare-ai-gateway-CLOUDFLARE_GATEWAY_ID',
    ) as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'gw');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onEndpointParamsChange).toHaveBeenLastCalledWith({
      CLOUDFLARE_ACCOUNT_ID: 'acct',
      CLOUDFLARE_GATEWAY_ID: 'gw',
    });
  });

  it('endpoint preview substitutes only known values', () => {
    expect(previewEndpoint('https://x/{A}/{B}', { A: ' a ' })).toBe('https://x/a/{B}');
  });
});

describe('add custom provider', () => {
  it('offers exactly the gateway-transport protocols and reports the choice', () => {
    const onAdd = vi.fn<(data: NewProviderData) => void>();
    act(() =>
      root.render(createElement(AddProviderDialog, { open: true, onOpenChange: vi.fn(), onAdd })),
    );
    const options = [...document.querySelectorAll('button[aria-pressed]')];
    expect(options.map((button) => button.textContent)).toEqual(
      CUSTOM_PROVIDER_APIS.map((api) => `settings.wireApis.${api}`),
    );
    act(() => (options[2] as HTMLButtonElement).click());
    const add = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'settings.addProviderButton',
    )!;
    act(() => add.click());
    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ api: 'anthropic-messages', type: 'anthropic' }),
    );
  });
});
