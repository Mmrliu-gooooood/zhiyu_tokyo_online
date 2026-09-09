import { useSettingsStore } from '@/lib/store/settings';
import {
  getThinkingConfigKey,
  normalizeThinkingConfig,
  supportsConfigurableThinking,
} from '@/lib/ai/thinking-config';
import { findModelById } from '@/lib/ai/model-aliases';
import { getCatalogThinkingCapability } from '@/lib/ai/model-metadata';

/**
 * Get current model configuration from settings store
 */
export function getCurrentModelConfig() {
  const { providerId, modelId, providersConfig, thinkingConfigs } = useSettingsStore.getState();
  const modelString = `${providerId}:${modelId}`;

  // Get current provider's config
  const providerConfig = providersConfig[providerId];
  const modelInfo = findModelById(providerId, providerConfig?.models, modelId);
  const thinking =
    modelInfo?.capabilities?.thinking ?? getCatalogThinkingCapability(providerId, modelId);
  const thinkingConfig = supportsConfigurableThinking(thinking)
    ? normalizeThinkingConfig(thinking, thinkingConfigs[getThinkingConfigKey(providerId, modelId)])
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
  };
}

/** Synchronize Home selection before PRO writes, without putting keys in message bodies. */
export async function getProModelRef() {
  const { flushProModelRevocation } = await import('@/lib/workbench/pro-model-connection-client');
  await flushProModelRevocation();
  const config = getCurrentModelConfig();
  // No local selection preserves explicit administrator routes on older deployments.
  if (!config.providerId || !config.modelId) return undefined;
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
