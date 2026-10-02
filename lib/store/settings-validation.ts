/**
 * Provider selection validation utilities.
 *
 * Pure functions used by fetchServerProviders() to detect and fix
 * stale provider/model selections after server config changes.
 */

import type { ModelSelection } from '@/lib/types/platform-default-models';
import { getDescriptor } from '@/lib/model-gateway/catalog/descriptors';

export type ProviderCfgLike = {
  isServerConfigured?: boolean;
  apiKey?: string;
  requiresApiKey?: boolean;
  baseUrl?: string;
  /** Operator force-disabled (server precedence, TTS — #665). Never usable. */
  serverDisabled?: boolean;
  /** LLM subscription sign-in (R2): usable only with an active credential. */
  authMode?: 'api-key' | 'oauth' | 'none';
  credentialId?: string;
  credentialStatus?: 'active' | 'reauth_required' | 'revoked';
};

/**
 * Check whether a provider has a usable *credential path* (server config or
 * client key/baseUrl). This is the store-level notion and deliberately does
 * NOT require ≥1 model — the UX-level "usable" predicate
 * ({@link isLLMProviderConfigured}) additionally requires a model, so a
 * pathological zero-model provider is classified State A at the UI boundary
 * even though the store may keep it selected with an empty model (#580).
 */
export function isProviderUsable(cfg: ProviderCfgLike | undefined): boolean {
  if (!cfg) return false;
  // Operator force-disable wins over any local credential path so the current
  // selection is re-pointed away from a server-disabled provider (#665).
  if (cfg.serverDisabled) return false;
  if (cfg.isServerConfigured) return true;
  if (cfg.authMode === 'oauth') return !!cfg.credentialId && cfg.credentialStatus === 'active';
  // Keyless providers (e.g. Ollama) need an explicit user-provided baseUrl
  if (cfg.requiresApiKey === false) return !!cfg.baseUrl;
  return !!cfg.apiKey;
}

export type MediaProviderCfgLike = ProviderCfgLike & { enabled?: boolean };

/** Media providers have an explicit user enablement switch in addition to the
 * shared credential-path rules used by selection reconciliation. */
export function isMediaProviderUsable(cfg: MediaProviderCfgLike | undefined): boolean {
  if (!cfg || cfg.enabled === false) return false;
  return isProviderUsable(cfg);
}

/**
 * Validate current provider selection against updated config.
 * Returns the current ID if still usable, otherwise the first usable
 * provider from fallbackOrder, or defaultId if provided, or ''.
 */
export function validateProvider<T extends string>(
  currentId: T | '',
  configMap: Partial<Record<T, ProviderCfgLike>>,
  fallbackOrder: T[],
  defaultId?: T,
): T | '' {
  if (!currentId) return currentId;
  if (isProviderUsable(configMap[currentId])) return currentId;

  for (const id of fallbackOrder) {
    if (isProviderUsable(configMap[id])) return id;
  }
  return defaultId ?? '';
}

/**
 * Validate current model selection against available models list.
 * Falls back to first available model, or '' if list is empty.
 */
export function validateModel(
  currentModelId: string,
  availableModels: Array<{ id: string }>,
): string {
  if (!currentModelId) return currentModelId;
  if (availableModels.some((m) => m.id === currentModelId)) return currentModelId;
  return availableModels[0]?.id ?? '';
}

/**
 * Resolve the model selection for a usable provider.
 *
 * Enforces the invariant "usable provider ⇒ a concrete model is selected":
 * keeps the current model if still valid, otherwise falls back to the first
 * available model. Unlike {@link validateModel} it has no empty-input
 * short-circuit, so it returns '' ONLY when the model list is empty (i.e. the
 * provider is not usable). Use this for model *selection resolution*; use
 * validateModel only for pure validation.
 */
export function resolveSelectedModel(
  currentModelId: string,
  availableModels: Array<{ id: string }>,
): string {
  if (availableModels.some((m) => m.id === currentModelId)) return currentModelId;
  return availableModels[0]?.id ?? '';
}

export interface LLMProviderCfgLike {
  requiresApiKey?: boolean;
  apiKey?: string;
  isServerConfigured?: boolean;
  models: Array<{ id: string }>;
  baseUrl?: string;
  defaultBaseUrl?: string;
  authMode?: 'api-key' | 'oauth' | 'none';
  credentialId?: string;
  credentialStatus?: 'active' | 'reauth_required' | 'revoked';
  endpointParams?: Record<string, string>;
}

/**
 * Canonical "this LLM provider is usable" predicate — single source of truth
 * shared by the generation toolbar selector and the landing-page generate
 * gate (#580). Deliberately consistent with {@link isProviderUsable} so the
 * gate/toolbar can never claim a provider is usable when the server-sync
 * reconcile would not actually select it:
 *
 * - server-configured ⇒ usable;
 * - subscription sign-in (`authMode: 'oauth'`) ⇒ usable ONLY while the
 *   server reports its credential `active` (plan 3.13);
 * - keyless provider (ollama/lemonade) ⇒ usable ONLY once the user sets an
 *   explicit baseUrl — the registry `defaultBaseUrl` alone is not user intent;
 * - key-requiring provider ⇒ needs a client key AND a resolvable endpoint,
 *   including every endpoint value its catalog entry declares (Cloudflare
 *   account / gateway id) when `providerId` is given.
 *
 * Always also requires ≥1 model.
 */
export function isLLMProviderConfigured(config: LLMProviderCfgLike, providerId?: string): boolean {
  if (!config.models || config.models.length < 1) return false;
  if (config.isServerConfigured) return true;
  if (config.authMode === 'oauth') {
    return !!config.credentialId && config.credentialStatus === 'active';
  }
  if (config.requiresApiKey === false) return !!config.baseUrl;
  if (!config.apiKey) return false;
  if (!(config.baseUrl || config.defaultBaseUrl)) return false;
  const declared = providerId ? (getDescriptor(providerId)?.endpointParams ?? []) : [];
  return declared.every((name) => !!config.endpointParams?.[name]?.trim());
}

/**
 * Whether the current selection must stay selected even though it is not
 * usable: a subscription that needs signing in again is reported to the user,
 * never silently replaced by another provider (plan 3.13).
 */
export function isLLMSelectionRetained(config: LLMProviderCfgLike, providerId?: string): boolean {
  return (
    isLLMProviderConfigured(config, providerId) ||
    (config.authMode === 'oauth' &&
      !!config.credentialId &&
      config.credentialStatus === 'reauth_required')
  );
}

/**
 * Whether at least one LLM provider is usable — i.e. the app is in state B
 * (≥1 usable provider) rather than state A (must configure a provider). Under
 * the #580 invariant this is exactly the condition under which a concrete
 * model is guaranteed to be selected.
 */
export function hasUsableLLMProvider(
  providersConfig: Record<string, LLMProviderCfgLike> | undefined | null,
): boolean {
  if (!providersConfig) return false;
  return Object.entries(providersConfig).some(([providerId, config]) =>
    isLLMProviderConfigured(config, providerId),
  );
}

type PlatformDefaultCatalogLike = {
  entries?: Array<{
    capability?: string;
    available?: boolean;
    defaultId?: string;
    revision?: string;
  }>;
};

/** Whether the creation UI has either a usable user provider or a revisioned
 * platform text default. Platform catalog v2 intentionally omits managed
 * providers from `providersConfig`, so gating only on that legacy map leaves
 * the home composer disabled even though its selected platform model is ready.
 */
export function hasUsableLLMSelection(
  providersConfig: Record<string, LLMProviderCfgLike> | undefined | null,
  platformDefaults: PlatformDefaultCatalogLike | undefined | null,
  selection: ModelSelection,
): boolean {
  if (selection.source === 'platform') {
    return (
      platformDefaults?.entries?.some(
        (entry) =>
          entry.capability === 'text' &&
          entry.defaultId === selection.defaultId &&
          entry.available === true &&
          !!entry.revision?.trim(),
      ) === true
    );
  }
  const selectedConfig = providersConfig?.[selection.providerId];
  return selectedConfig ? isLLMProviderConfigured(selectedConfig, selection.providerId) : false;
}
