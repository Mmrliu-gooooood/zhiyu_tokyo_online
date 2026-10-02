import type { ProviderId, ProviderType, ModelInfo } from '@/lib/types/provider';
import type { ProviderSettings } from '@/lib/types/settings';
import type { WireApi } from '@/lib/model-gateway/types';
import { getCatalogThinkingCapability } from '@/lib/model-gateway/catalog/client-catalog';

/** Heuristic: model ids matching this are treated as vision-capable. */
const VISION_MODEL_PATTERN = /vision|vl|omni|4o|gpt-5|gemini|claude/i;

/**
 * Builds a default ModelInfo from a probed model id. Vision capability is
 * inferred from the id via {@link VISION_MODEL_PATTERN}. Shared by the provider
 * panel and the token-plan apply flow so the heuristic stays in one place.
 *
 * When `providerId` is given, the built-in thinking capability for that
 * (provider, model) pair is overlaid — so a model that supports configurable
 * thinking keeps its `capabilities.thinking` instead of silently losing it
 * (which would hide InlineThinkingControl). Unknown pairs are unaffected.
 */
export function modelInfoFromId(id: string, providerId?: string): ModelInfo {
  const thinking = providerId ? getCatalogThinkingCapability(providerId, id) : undefined;
  return {
    id,
    name: id,
    capabilities: {
      streaming: true,
      tools: true,
      vision: VISION_MODEL_PATTERN.test(id),
      ...(thinking ? { thinking } : {}),
    },
  };
}

interface NewCustomProviderConfig {
  name: string;
  type: ProviderType;
  /** Wire protocol of a user-defined provider (sent as x-model-api). */
  api?: WireApi;
  baseUrl: string;
  icon: string;
  requiresApiKey: boolean;
  /** Optional explicit /models URL override (from a preset). */
  modelsUrl?: string;
}

export function formatContextWindow(size?: number): string {
  if (!size) return '-';

  // For M: prefer decimal (use decimal for exact thousands)
  if (size >= 1000000) {
    if (size % 1000000 === 0) {
      return `${size / 1000000}M`;
    }
    return `${(size / 1000000).toFixed(1)}M`;
  }

  // For K: prefer decimal if divisible by 1000, otherwise use binary
  if (size >= 1000) {
    if (size % 1000 === 0) {
      return `${size / 1000}K`;
    }
    return `${Math.floor(size / 1024)}K`;
  }

  return size.toString();
}

export function getProviderTypeLabel(type: string, t: (key: string) => string): string {
  const translationKey = `settings.providerTypes.${type}`;
  const translated = t(translationKey);
  // If translation exists (not equal to key), use it; otherwise fallback to type
  return translated !== translationKey ? translated : type;
}

export function createCustomProviderSettings(
  providerData: NewCustomProviderConfig,
): ProviderSettings {
  return {
    ...(providerData.api ? { api: providerData.api } : {}),
    apiKey: '',
    baseUrl: providerData.baseUrl || '',
    models: [],
    name: providerData.name,
    type: providerData.type,
    defaultBaseUrl: providerData.baseUrl || undefined,
    icon: providerData.icon || undefined,
    requiresApiKey: providerData.requiresApiKey,
    isBuiltIn: false,
    modelsUrl: providerData.modelsUrl || undefined,
  };
}

interface VerifyModelRequestConfig {
  providerId: ProviderId;
  modelId: string;
  apiKey?: string;
  baseUrl?: string;
  providerType?: ProviderType | string;
  requiresApiKey?: boolean;
  api?: WireApi;
  endpointProfile?: string;
  endpointParams?: Record<string, string>;
}

export function createVerifyModelRequest(config: VerifyModelRequestConfig) {
  const endpointParams = Object.fromEntries(
    Object.entries(config.endpointParams ?? {})
      .map(([name, value]) => [name, value.trim()] as const)
      .filter(([, value]) => value),
  );
  return {
    apiKey: config.apiKey || '',
    baseUrl: config.baseUrl || '',
    model: `${config.providerId}:${config.modelId}`,
    providerType: config.providerType,
    requiresApiKey: config.requiresApiKey,
    ...(config.api ? { api: config.api } : {}),
    ...(config.endpointProfile ? { endpointProfile: config.endpointProfile } : {}),
    ...(Object.keys(endpointParams).length > 0 ? { endpointParams } : {}),
  };
}

/** Request path the settings preview appends to a base URL, by wire protocol. */
export function requestPathForApi(api: WireApi | undefined, type: ProviderType): string {
  switch (api) {
    case 'openai-completions':
      return '/chat/completions';
    case 'openai-responses':
      return '/responses';
    case 'anthropic-messages':
      return '/messages';
    case 'azure-openai-responses':
      return '/v1/responses?api-version=v1';
    case 'google-generative-ai':
      return '/models/[model]';
    case undefined:
      break;
    default:
      return '';
  }
  switch (type) {
    case 'openai':
      return '/chat/completions';
    case 'azure':
      return '/v1/responses?api-version=v1';
    case 'anthropic':
      return '/messages';
    case 'google':
      return '/models/[model]';
    default:
      return '';
  }
}
