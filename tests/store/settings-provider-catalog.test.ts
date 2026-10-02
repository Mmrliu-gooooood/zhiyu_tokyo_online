/**
 * P5-1: the settings store over the full grouped catalog. A persisted v7
 * settings blob (the version in production before the gateway) must keep every
 * model choice, key, base URL, custom provider, manual model and thinking
 * setting, gain the new catalog providers, and stay at persist version 7.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserKVStore } from '@openmaic/storage';
import v7Blob from '@/tests/fixtures/settings/settings-v7-blob.json';
import { CLIENT_PROVIDERS } from '@/lib/model-gateway/catalog/client-catalog';

const backing = new Map<string, string>();
const localStorageStub: Storage = {
  get length() {
    return backing.size;
  },
  clear: () => backing.clear(),
  getItem: (k: string) => backing.get(k) ?? null,
  key: (i: number) => [...backing.keys()][i] ?? null,
  removeItem: (k: string) => void backing.delete(k),
  setItem: (k: string, v: string) => void backing.set(k, v),
};
vi.stubGlobal('localStorage', localStorageStub);
vi.stubGlobal('window', { localStorage: localStorageStub });
vi.stubGlobal(
  'fetch',
  vi.fn(async () => ({ ok: false, json: async () => ({}) })),
);

const kv = new BrowserKVStore({ storage: localStorageStub });
const NAME = 'settings-storage';

async function hydratedStore() {
  const { useSettingsStore } = await import('@/lib/store/settings');
  await useSettingsStore.persist.rehydrate();
  return useSettingsStore;
}

beforeEach(() => {
  backing.clear();
  vi.resetModules();
});

describe('settings over the full catalog', () => {
  it('fresh settings list every catalog provider as built-in', async () => {
    const store = await hydratedStore();
    const config = store.getState().providersConfig;
    for (const id of Object.keys(CLIENT_PROVIDERS)) {
      expect(config[id as keyof typeof config], id).toMatchObject({
        apiKey: '',
        isBuiltIn: true,
      });
    }
    // A fixed-endpoint provider carries its catalog endpoint for display.
    expect(config['groq' as keyof typeof config]?.defaultBaseUrl).toBe(
      'https://api.groq.com/openai/v1',
    );
  });

  it('a v7 blob keeps every user choice and gains the new providers', async () => {
    await kv.set(NAME, v7Blob, 'account');
    const store = await hydratedStore();
    const state = store.getState();
    const config = state.providersConfig as Record<
      string,
      (typeof state.providersConfig)['openai']
    >;

    expect(state.providerId).toBe('deepseek');
    expect(state.modelId).toBe('deepseek-v4-pro');
    expect(state.llmSelection).toEqual({
      source: 'user',
      providerId: 'deepseek',
      modelId: 'deepseek-v4-pro',
    });
    expect(state.thinkingConfigs).toEqual(v7Blob.state.thinkingConfigs);
    expect(state.playbackSpeed).toBe(1.25);

    expect(config.openai).toMatchObject({
      apiKey: 'sk-test-openai-relay',
      baseUrl: 'https://relay.example.com/v1',
    });
    expect(config.openai!.models.map((model) => model.id)).toContain('my-relay-model');
    expect(config.kimi).toMatchObject({
      apiKey: 'sk-test-kimi',
      baseUrl: 'https://api.moonshot.ai/v1',
    });
    expect(config.ollama).toMatchObject({ baseUrl: 'http://localhost:11434/v1' });
    expect(config.ollama!.models.map((model) => model.id)).toContain('qwen3:8b');
    expect(config['custom-1759300000000']).toEqual(
      v7Blob.state.providersConfig['custom-1759300000000'],
    );

    for (const id of ['groq', 'zai-coding', 'xiaomi-token-plan-cn', 'cloudflare-ai-gateway']) {
      expect(config[id], id).toMatchObject({ apiKey: '', isBuiltIn: true });
      expect(config[id]!.models.length, id).toBeGreaterThan(0);
    }

    // No persist-version bump: an older build reading this blob keeps its settings.
    store.getState().setPlaybackSpeed(1.5);
    await vi.waitFor(async () => {
      const written = await kv.get<{ version: number; state: { playbackSpeed: number } }>(
        NAME,
        'account',
      );
      expect(written?.state.playbackSpeed).toBe(1.5);
      expect(written?.version).toBe(7);
    });
  });

  it('a subscription awaiting re-sign-in is not replaced by another provider', async () => {
    const store = await hydratedStore();
    const { setModel, setProviderConfig } = store.getState();
    setProviderConfig('deepseek', { apiKey: 'sk-test' });
    setProviderConfig('openai', {
      authMode: 'oauth',
      credentialId: '00000000-0000-4000-8000-000000000001',
      credentialStatus: 'active',
    });
    setModel('openai', 'gpt-5.4');
    expect(store.getState().providerId).toBe('openai');

    setProviderConfig('openai', { credentialStatus: 'reauth_required' });
    expect(store.getState().providerId).toBe('openai');
    expect(store.getState().modelId).toBe('gpt-5.4');

    // A revoked credential is unusable: the selection moves to a usable provider.
    setProviderConfig('openai', { credentialStatus: 'revoked' });
    expect(store.getState().providerId).toBe('deepseek');
  });
});
