import { useSettingsStore } from '@/lib/store/settings';
import {
  getThinkingConfigKey,
  normalizeThinkingConfig,
  supportsConfigurableThinking,
} from '@/lib/ai/thinking-config';
import { findModelById } from '@/lib/ai/model-aliases';
import { getCatalogThinkingCapability } from '@/lib/ai/model-metadata';
import type { ThinkingConfig } from '@/lib/types/provider';
import type { ModelSelection } from '@/lib/types/platform-default-models';

function hasExplicitThinkingIntent(config: ThinkingConfig | undefined): boolean {
  return Boolean(
    config &&
    ((config.mode !== undefined && config.mode !== 'default') ||
      config.effort !== undefined ||
      config.level !== undefined ||
      config.enabled !== undefined ||
      config.budgetTokens !== undefined ||
      config.excludeReasoningOutput !== undefined),
  );
}

function selectedPlatformRevision(
  selection: ModelSelection,
  entries: ReturnType<typeof useSettingsStore.getState>['platformDefaults'],
): string | undefined {
  return selection.source === 'platform'
    ? entries?.entries.find((entry) => entry.defaultId === selection.defaultId)?.revision
    : undefined;
}

/**
 * Get current model configuration from settings store
 */
export function getCurrentModelConfig() {
  const { providerId, modelId, providersConfig, thinkingConfigs, llmSelection, platformDefaults } =
    useSettingsStore.getState();
  const selection: ModelSelection = llmSelection ?? {
    source: 'legacy-managed',
    providerId,
    modelId,
  };
  const providerConfig = providersConfig[providerId];
  const modelInfo = findModelById(providerId, providerConfig?.models, modelId);
  const thinking =
    modelInfo?.capabilities?.thinking ?? getCatalogThinkingCapability(providerId, modelId);
  const savedThinking = thinkingConfigs[getThinkingConfigKey(providerId, modelId)];
  if (selection.source === 'platform') {
    const entry = platformDefaults?.entries.find(
      (candidate) => candidate.defaultId === selection.defaultId,
    );
    const selectedThinking = hasExplicitThinkingIntent(savedThinking)
      ? savedThinking
      : entry?.defaultThinkingConfig;
    const thinkingConfig = supportsConfigurableThinking(thinking)
      ? normalizeThinkingConfig(thinking, selectedThinking)
      : entry?.defaultThinkingConfig;
    return {
      providerId,
      modelId,
      modelString: '',
      apiKey: '',
      baseUrl: '',
      providerType: undefined,
      requiresApiKey: false,
      isServerConfigured: true,
      thinkingConfig,
      api: undefined,
      source: selection.source,
      defaultId: selection.defaultId,
      revision: selectedPlatformRevision(selection, platformDefaults),
    };
  }
  const modelString = `${providerId}:${modelId}`;

  const thinkingConfig = supportsConfigurableThinking(thinking)
    ? normalizeThinkingConfig(thinking, savedThinking)
    : undefined;

  return {
    providerId,
    modelId,
    modelString,
    apiKey: providerConfig?.apiKey || '',
    baseUrl: providerConfig?.baseUrl || '',
    providerType: providerConfig?.type,
    requiresApiKey: providerConfig?.requiresApiKey,
    isServerConfigured: providerConfig?.isServerConfigured,
    thinkingConfig,
    api: providerConfig?.api,
    source: selection.source,
    defaultId: undefined,
    revision: undefined,
  };
}

/** Synchronize Home selection before PRO writes, without putting keys in message bodies. */
export async function getProModelRef() {
  const { flushProModelRevocation } = await import('@/lib/workbench/pro-model-connection-client');
  await flushProModelRevocation();
  const config = getCurrentModelConfig();
  // No local selection preserves explicit administrator routes on older deployments.
  if (config.source !== 'platform' && (!config.providerId || !config.modelId)) return undefined;
  const { syncProModelConnection, proModelConfigurationMessage } =
    await import('@/lib/workbench/pro-model-connection-client');
  const modelRef = await syncProModelConnection(config);
  const response = await fetch('/api/agent/runtime', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelRef }),
  });
  const readiness = await response.json().catch(() => ({}));
  if (!response.ok || readiness.chatReady !== true || readiness.generationReady !== true) {
    throw new Error(proModelConfigurationMessage(readiness.error));
  }
  return modelRef;
}
