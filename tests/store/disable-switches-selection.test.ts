/**
 * Disabling a selected image/video provider clears the paid capability instead
 * of silently selecting another provider. TTS/web-search retain their existing
 * capability-specific fallback contracts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useSettingsStore } from '@/lib/store/settings';

describe('disabling the active provider applies the capability fallback policy', () => {
  beforeEach(() => {
    // Reset selections to known non-default providers per test below.
    useSettingsStore.setState({
      imageProviderId: 'seedream',
      videoProviderId: 'seedance',
      ttsProviderId: 'browser-native-tts',
      webSearchProviderId: 'tavily',
    });
  });

  it('image: disabling the selected provider clears selection without paid fallback', () => {
    const s = useSettingsStore.getState();
    s.setImageProvider('openai-image');
    expect(useSettingsStore.getState().imageProviderId).toBe('openai-image');

    s.setImageProviderConfig('openai-image', { enabled: false });
    expect(useSettingsStore.getState().imageProviderId).toBe('');
    expect(useSettingsStore.getState().imageGenerationEnabled).toBe(false);
  });

  it('image: disabling the default selected provider does not select itself', () => {
    useSettingsStore.setState((state) => ({
      imageProviderId: 'seedream',
      imageGenerationEnabled: true,
      imageProvidersConfig: {
        ...state.imageProvidersConfig,
        seedream: { apiKey: 'ark-test', baseUrl: '', enabled: true },
        'openai-image': { apiKey: '', baseUrl: '', enabled: false },
      },
    }));

    const s = useSettingsStore.getState();
    s.setImageProviderConfig('seedream', { apiKey: '', enabled: false });
    expect(useSettingsStore.getState().imageProviderId).toBe('');
    expect(useSettingsStore.getState().imageGenerationEnabled).toBe(false);
  });

  it('image: disabling a NON-selected provider leaves the selection alone', () => {
    const s = useSettingsStore.getState();
    s.setImageProvider('seedream');
    s.setImageProviderConfig('openai-image', { enabled: false });
    expect(useSettingsStore.getState().imageProviderId).toBe('seedream');
  });

  it('video: disabling the selected provider clears selection without paid fallback', () => {
    const s = useSettingsStore.getState();
    s.setVideoProvider('kling');
    expect(useSettingsStore.getState().videoProviderId).toBe('kling');

    s.setVideoProviderConfig('kling', { enabled: false });
    expect(useSettingsStore.getState().videoProviderId).toBe('');
    expect(useSettingsStore.getState().videoGenerationEnabled).toBe(false);
  });

  it('video: disabling the default selected provider does not select itself', () => {
    useSettingsStore.setState((state) => ({
      videoProviderId: 'seedance',
      videoGenerationEnabled: true,
      videoProvidersConfig: {
        ...state.videoProvidersConfig,
        seedance: { apiKey: 'ark-test', baseUrl: '', enabled: true },
        kling: { apiKey: '', baseUrl: '', enabled: false },
      },
    }));

    const s = useSettingsStore.getState();
    s.setVideoProviderConfig('seedance', { apiKey: '', enabled: false });
    expect(useSettingsStore.getState().videoProviderId).toBe('');
    expect(useSettingsStore.getState().videoGenerationEnabled).toBe(false);
  });

  it('tts: disabling the selected provider falls back to browser TTS', () => {
    const s = useSettingsStore.getState();
    s.setTTSProvider('openai-tts');
    expect(useSettingsStore.getState().ttsProviderId).toBe('openai-tts');

    s.setTTSProviderConfig('openai-tts', { enabled: false });
    expect(useSettingsStore.getState().ttsProviderId).toBe('browser-native-tts');
  });

  it('web search: disabling the selected provider falls back to tavily', () => {
    const s = useSettingsStore.getState();
    s.setWebSearchProvider('bocha');
    expect(useSettingsStore.getState().webSearchProviderId).toBe('bocha');

    s.setWebSearchProviderConfig('bocha', { enabled: false });
    expect(useSettingsStore.getState().webSearchProviderId).toBe('tavily');
  });

  it('enabling/other edits do NOT force a switch away', () => {
    const s = useSettingsStore.getState();
    s.setImageProvider('openai-image');
    s.setImageProviderConfig('openai-image', { apiKey: 'sk-x', enabled: true });
    expect(useSettingsStore.getState().imageProviderId).toBe('openai-image');
  });

  it('atomically enables and selects a configured image provider', () => {
    useSettingsStore.setState((state) => ({
      imageProviderId: 'minimax-image',
      imageModelId: '',
      imageGenerationEnabled: false,
      imageProvidersConfig: {
        ...state.imageProvidersConfig,
        'minimax-image': {
          ...state.imageProvidersConfig['minimax-image'],
          apiKey: 'minimax-session-key',
          enabled: false,
        },
      },
    }));

    const activation = useSettingsStore.getState().setImageGenerationEnabled(true);

    expect(activation).toEqual({
      ok: true,
      providerId: 'minimax-image',
      modelId: 'image-01',
    });
    expect(useSettingsStore.getState()).toMatchObject({
      imageGenerationEnabled: true,
      imageProviderId: 'minimax-image',
      imageModelId: 'image-01',
      imageProvidersConfig: { 'minimax-image': { enabled: true } },
    });
  });

  it('returns a structured reason and preserves state when media has no credentials', () => {
    useSettingsStore.setState((state) => ({
      videoProviderId: 'minimax-video',
      videoModelId: '',
      videoGenerationEnabled: false,
      videoProvidersConfig: Object.fromEntries(
        Object.entries(state.videoProvidersConfig).map(([id, config]) => [
          id,
          { ...config, apiKey: '', isServerConfigured: false, enabled: false },
        ]),
      ) as typeof state.videoProvidersConfig,
    }));

    const activation = useSettingsStore.getState().setVideoGenerationEnabled(true);

    expect(activation).toEqual({ ok: false, reason: 'missing-credentials' });
    expect(useSettingsStore.getState()).toMatchObject({
      videoGenerationEnabled: false,
      videoProviderId: 'minimax-video',
      videoModelId: '',
    });
  });
});
