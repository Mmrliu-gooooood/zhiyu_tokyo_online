/**
 * Settings-UI view of the catalog (plan 3.13): descriptors + reviewed overlays
 * for the 19 pre-gateway providers, descriptors + generated pi data for the
 * rest. Produces the existing ProviderConfig / ModelInfo shape plus the new
 * descriptor fields. Isomorphic and secret-free.
 */
import type { ModelInfo, ProviderConfig, ProviderType } from '@/lib/types/provider';
import type { WireApi } from '../types';
import {
  PROVIDER_DESCRIPTORS,
  type AuthMethod,
  type ModelDiscovery,
  type ProviderDescriptor,
  type ProviderGroup,
} from './descriptors';
import piCatalog from './generated/pi-models.json';
import { REVIEWED_MODELS } from './reviewed-models';
import { deriveThinkingCapability } from './thinking-capability';

export interface ClientProviderConfig extends Omit<ProviderConfig, 'id' | 'type'> {
  id: string;
  type: ProviderType;
  group: ProviderGroup;
  authMethods: readonly AuthMethod[];
  userConfigurable: boolean;
  modelDiscovery: ModelDiscovery;
  allowCustomBaseUrl: boolean;
  allowedApis?: readonly WireApi[];
  endpointProfiles?: readonly { id: string; label: string }[];
  endpointParams?: readonly string[];
}

interface CatalogModel {
  id: string;
  name: string;
  api?: string;
  reasoning: boolean;
  input: readonly string[];
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: Record<string, string | null>;
}

interface CatalogProvider {
  api: string;
  models: CatalogModel[];
}

const PI_PROVIDERS = piCatalog.providers as Record<string, CatalogProvider>;

/** Version of the generated pi data the catalog was built from. */
export const CATALOG_VERSION = `${piCatalog.piVersion}+${piCatalog.contentHash}`;

function piProviderIdOf(descriptor: ProviderDescriptor): string | undefined {
  return descriptor.upstream.kind === 'pi' ? descriptor.upstream.piProviderId : undefined;
}

function legacyTypeFor(descriptor: ProviderDescriptor, api: string | undefined): ProviderType {
  if (descriptor.legacyProviderType) return descriptor.legacyProviderType;
  if (api === 'anthropic-messages') return 'anthropic';
  if (api === 'google-generative-ai' || api === 'google-vertex') return 'google';
  if (api === 'bedrock-converse-stream') return 'bedrock';
  return 'openai';
}

function piModelInfo(model: CatalogModel): ModelInfo {
  const thinking = deriveThinkingCapability(model);
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    outputWindow: model.maxTokens,
    capabilities: {
      streaming: true,
      tools: true,
      vision: model.input.includes('image'),
      ...(thinking ? { thinking } : {}),
    },
  };
}

function modelsFor(descriptor: ProviderDescriptor): ModelInfo[] {
  const reviewed = REVIEWED_MODELS[descriptor.id];
  if (reviewed) return reviewed.map((model) => structuredClone(model));
  const piProviderId = piProviderIdOf(descriptor);
  return (piProviderId ? PI_PROVIDERS[piProviderId]?.models : undefined)?.map(piModelInfo) ?? [];
}

function toClientConfig(descriptor: ProviderDescriptor): ClientProviderConfig {
  const piProviderId = piProviderIdOf(descriptor);
  const api =
    descriptor.upstream.kind === 'custom'
      ? descriptor.upstream.api
      : piProviderId
        ? PI_PROVIDERS[piProviderId]?.api
        : undefined;
  const profiles =
    descriptor.upstream.kind === 'pi' && descriptor.upstream.profiles
      ? Object.entries(descriptor.upstream.profiles).map(([id, profile]) => ({
          id,
          label: profile.label,
        }))
      : undefined;
  return {
    id: descriptor.id,
    name: descriptor.name,
    type: legacyTypeFor(descriptor, api),
    ...(descriptor.defaultBaseUrl ? { defaultBaseUrl: descriptor.defaultBaseUrl } : {}),
    ...(descriptor.baseUrlPlaceholder ? { baseUrlPlaceholder: descriptor.baseUrlPlaceholder } : {}),
    supportsModelDiscovery: descriptor.modelDiscovery !== 'manual',
    ...(descriptor.alternateBaseUrls
      ? { alternateBaseUrls: descriptor.alternateBaseUrls.map((entry) => ({ ...entry })) }
      : {}),
    requiresApiKey: !descriptor.auth.includes('none') && !descriptor.auth.includes('ambient'),
    ...(descriptor.icon ? { icon: descriptor.icon } : {}),
    models: modelsFor(descriptor),
    group: descriptor.group,
    authMethods: descriptor.auth,
    userConfigurable: descriptor.userConfigurable,
    modelDiscovery: descriptor.modelDiscovery,
    allowCustomBaseUrl: descriptor.allowCustomBaseUrl,
    ...(descriptor.allowedApis ? { allowedApis: descriptor.allowedApis } : {}),
    ...(profiles ? { endpointProfiles: profiles } : {}),
    ...(descriptor.endpointParams ? { endpointParams: descriptor.endpointParams } : {}),
  };
}

/** Every catalog provider, keyed by application id. */
export const CLIENT_PROVIDERS: Readonly<Record<string, ClientProviderConfig>> = Object.freeze(
  Object.fromEntries(
    Object.values(PROVIDER_DESCRIPTORS).map((descriptor) => [
      descriptor.id,
      toClientConfig(descriptor),
    ]),
  ),
);
