/**
 * Settings-UI view of the catalog (plan 3.13): descriptors + reviewed overlays
 * for the 19 pre-gateway providers, descriptors + generated pi data for the
 * rest. Produces the existing ProviderConfig / ModelInfo shape plus the new
 * descriptor fields. Isomorphic and secret-free.
 */
import type { ModelInfo, ProviderConfig, ProviderId, ProviderType } from '@/lib/types/provider';
import type { WireApi } from '../types';
import {
  LEGACY_PROVIDER_IDS,
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
  baseUrl?: string;
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
  // A user-configurable provider with a fixed endpoint shows pi's endpoint
  // (display and the "has an endpoint" usability check only; it is never sent).
  const defaultBaseUrl =
    descriptor.defaultBaseUrl ??
    (descriptor.userConfigurable && !descriptor.allowCustomBaseUrl && piProviderId
      ? PI_PROVIDERS[piProviderId]?.baseUrl
      : undefined);
  return {
    id: descriptor.id,
    name: descriptor.name,
    type: legacyTypeFor(descriptor, api),
    ...(defaultBaseUrl ? { defaultBaseUrl } : {}),
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

/**
 * The 19 pre-gateway providers in the legacy ProviderConfig shape (the deleted
 * lib/ai/providers.ts `PROVIDERS`). The settings UI uses the full grouped
 * CLIENT_PROVIDERS since P5; this view remains for characterization fixtures
 * and is pinned by tests/model-gateway/catalog/legacy-parity.test.ts.
 */
export const PROVIDERS = Object.fromEntries(
  LEGACY_PROVIDER_IDS.map((id) => [id, CLIENT_PROVIDERS[id]!]),
) as unknown as Record<ProviderId, ProviderConfig>;

/** Providers whose logos are monochrome (rendered with `dark:invert`). */
export const MONO_LOGO_PROVIDERS: ReadonlySet<string> = new Set([
  'openai',
  'openrouter',
  'ollama',
  'atlascloud',
  'groq',
  'baseten',
  'vercel-ai-gateway',
  'opencode',
  'opencode-go',
  'zai-coding',
  'github-copilot',
]);

/** A catalog provider by application id (any descriptor, not only the legacy 19). */
export function getProvider(providerId: string): ClientProviderConfig | undefined {
  return CLIENT_PROVIDERS[providerId];
}

/** Reviewed thinking capability of a catalog model (aliases resolved). */
export { reviewedThinkingCapability as getCatalogThinkingCapability } from './thinking-capability';

/** Settings-list order of the provider groups (plan 3.13). */
export const PROVIDER_GROUP_ORDER: readonly ProviderGroup[] = [
  'official',
  'china',
  'aggregator',
  'coding-plan',
  'subscription',
  'enterprise',
  'local',
];

/** Whether the deployment offers subscription sign-in for this provider. */
export function oauthSignInAvailable(
  providerId: string,
  oauthProviders: readonly string[] | undefined,
): boolean {
  return Boolean(
    CLIENT_PROVIDERS[providerId]?.authMethods.includes('oauth') &&
    oauthProviders?.includes(providerId),
  );
}

/**
 * Whether a provider appears in the settings list. Operator-only providers
 * (Bedrock, Vertex) appear only when the operator configured them (P2-6), and
 * sign-in-only providers only when the deployment enables their sign-in (D14).
 * User-defined `custom-*` providers always appear.
 */
export function isProviderListed(
  providerId: string,
  options: { serverConfigured?: boolean; oauthProviders?: readonly string[] },
): boolean {
  const provider = CLIENT_PROVIDERS[providerId];
  if (!provider) return true;
  if (!provider.userConfigurable) return options.serverConfigured === true;
  const signInOnly = provider.authMethods.every((method) => method === 'oauth');
  if (signInOnly) {
    return (
      options.serverConfigured === true || oauthSignInAvailable(providerId, options.oauthProviders)
    );
  }
  return true;
}
