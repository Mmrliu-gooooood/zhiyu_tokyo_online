/**
 * Build the resolved pi model for a binding: pi catalog data (or a provider
 * template for unknown ids) → reviewed overlay (names, windows, vision,
 * thinking) → request-shape compat derived from the reviewed thinking
 * capability → endpoint. Server-only.
 */
import type { ModelInfo, ThinkingCapability } from '@/lib/types/provider';
import { getCanonicalModelId } from '@/lib/ai/model-aliases';
import {
  CUSTOM_PROVIDER_APIS,
  getDescriptor,
  type ProviderDescriptor,
} from '../catalog/descriptors';
import { modelHint, openaiDefaultApi } from '../catalog/overlays';
import { REVIEWED_MODELS } from '../catalog/reviewed-models';
import {
  deriveThinkingCapability,
  reviewedThinkingCapability,
} from '../catalog/thinking-capability';
import { loadPiProvider } from '../runtime/pi-registry';
import type { ModelCapabilities, PiModel, WireApi } from '../types';

export interface ModelSpecInput {
  providerId: string;
  modelId: string;
  /** Explicit wire API (connection or stage route); honoured where the descriptor allows. */
  api?: WireApi;
  /** Explicit endpoint (user, operator or platform); undefined = catalog default. */
  baseUrl?: string;
  endpointProfile?: string;
}

export interface ModelSpec {
  model: PiModel;
  upstream: 'pi' | 'custom';
  capabilities: ModelCapabilities;
  inlineThinkTags: boolean;
  descriptor?: ProviderDescriptor;
}

export class ModelSpecError extends Error {
  constructor(
    readonly reason: 'unknown-provider' | 'missing-api' | 'missing-endpoint' | 'unsupported-api',
  ) {
    super(`Model cannot be resolved: ${reason}`);
    this.name = 'ModelSpecError';
  }
}

const EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * What the legacy OpenAI-compatible transport sent to non-OpenAI endpoints:
 * `max_tokens`, a `system` role and no `store` (pi would otherwise detect an
 * unknown host as OpenAI and send max_completion_tokens / developer).
 */
const COMPATIBLE_ENDPOINT_DEFAULTS = {
  maxTokensField: 'max_tokens',
  supportsDeveloperRole: false,
  supportsStore: false,
} as const;

/** Unknown models: conservative output cap (plan 3.7; Anthropic requires one). */
const UNKNOWN_MODEL_MAX_TOKENS = 8_192;

function findReviewed(providerId: string, modelId: string): ModelInfo | undefined {
  const canonical = getCanonicalModelId(providerId, modelId);
  return REVIEWED_MODELS[providerId]?.find((model) => model.id === canonical);
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

async function piProviderFor(
  descriptor: ProviderDescriptor & { upstream: { kind: 'pi' } },
  baseUrl: string | undefined,
  profile: string | undefined,
): Promise<string> {
  const profiles = descriptor.upstream.profiles;
  if (!profiles) return descriptor.upstream.piProviderId;
  if (profile && profiles[profile]) return profiles[profile].piProviderId;
  const host = hostOf(baseUrl);
  if (host) {
    for (const entry of Object.values(profiles)) {
      const provider = await loadPiProvider(entry.piProviderId);
      if (hostOf(provider.getModels()[0]?.baseUrl) === host) return entry.piProviderId;
    }
  }
  return descriptor.upstream.piProviderId;
}

/**
 * pi compat implied by the reviewed request adapter, for endpoints pi cannot
 * recognize by host (custom descriptors, relays).
 */
function adapterCompat(capability: ThinkingCapability | undefined): Record<string, unknown> {
  switch (capability?.requestAdapter) {
    case 'deepseek':
      return { thinkingFormat: 'deepseek' };
    case 'kimi':
    case 'xiaomi':
      return { thinkingFormat: 'deepseek', supportsReasoningEffort: false };
    case 'glm':
      return { thinkingFormat: 'zai', supportsReasoningEffort: capability.control === 'effort' };
    case 'siliconflow':
      // Budget-only models take just the budget field (no enable switch).
      if (capability.control === 'budget-only') {
        return {
          thinkingFormat: 'openai',
          thinkingTokenBudgetField: 'thinking_budget',
          supportsReasoningEffort: false,
        };
      }
      return {
        thinkingFormat: 'qwen',
        thinkingTokenBudgetField: 'thinking_budget',
        supportsReasoningEffort: false,
      };
    case 'qwen':
      return {
        thinkingFormat: 'qwen',
        thinkingTokenBudgetField: 'thinking_budget',
        supportsReasoningEffort: false,
      };
    case 'doubao':
      return capability.control === 'effort'
        ? { supportsReasoningEffort: true }
        : { thinkingFormat: 'deepseek', supportsReasoningEffort: false };
    case 'openrouter':
      return { thinkingFormat: 'openrouter' };
    case 'hunyuan':
      return {
        thinkingFormat: 'chat-template',
        chatTemplateKwargs: { reasoning_effort: {} },
        supportsReasoningEffort: false,
      };
    case 'lemonade':
      return {
        thinkingFormat: 'chat-template',
        chatTemplateKwargs: {
          enable_thinking: { $var: 'thinking.enabled' },
          thinking_budget: { $var: 'thinking.budget', omitWhenOff: true },
        },
        supportsReasoningEffort: false,
      };
    case 'openai':
      return { supportsReasoningEffort: true };
    default:
      return {};
  }
}

/** Level map entries implied by the reviewed capability (pi treats xhigh / max as opt-in). */
function adapterLevelMap(
  capability: ThinkingCapability | undefined,
): Record<string, string | null> | undefined {
  if (!capability) return undefined;
  if (capability.requestAdapter === 'hunyuan') {
    return {
      off: 'no_think',
      minimal: 'low',
      low: 'low',
      medium: 'low',
      high: 'high',
      xhigh: 'high',
      max: 'high',
    };
  }
  if (capability.requestAdapter === 'doubao' && capability.control === 'effort') {
    return { off: 'minimal' };
  }
  // Every reviewed effort / level is sendable as itself, even where pi's catalog
  // marks it unsupported (pi would otherwise clamp it to another level).
  const map: Record<string, string> = {};
  for (const level of [...(capability.effortValues ?? []), ...(capability.levelValues ?? [])]) {
    if ((EFFORT_LEVELS as readonly string[]).includes(level)) map[level] = level;
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

/**
 * Azure portal URLs → the resource base the OpenAI SDK appends `/responses`
 * to: strip operation / deployment suffixes, add `/openai` on classic hosts
 * and the `/v1` the legacy @ai-sdk/azure client appended.
 */
function normalizeAzureBaseUrl(value: string): string {
  const url = new URL(value.trim());
  url.search = '';
  url.hash = '';
  let path = url.pathname.replace(/\/+$/, '');
  path = path.replace(/\/(?:chat\/completions|responses)$/i, '');
  path = path.replace(/\/deployments\/[^/]+$/i, '');
  path = path.replace(/\/v1$/i, '');
  if (url.hostname.endsWith('.openai.azure.com') && !path) path = '/openai';
  url.pathname = `${path}/v1`;
  return url.toString().replace(/\/$/, '');
}

/** pi's Anthropic SDK appends `/v1`; legacy base URLs include it. */
function normalizeBaseUrl(api: string, providerId: string, baseUrl: string): string {
  if (api === 'azure-openai-responses') return normalizeAzureBaseUrl(baseUrl);
  let url = baseUrl.trim().replace(/\/+$/, '');
  if (api === 'anthropic-messages') {
    if (providerId === 'minimax' && !/\/anthropic(\/v1)?$/.test(url)) url = `${url}/anthropic`;
    url = url.replace(/\/v1$/, '');
  }
  return url;
}

/**
 * Compat keys that describe the endpoint's dialect (safe for any model of the
 * provider). Model feature flags (mid-conversation effort / tool changes,
 * adaptive thinking, fallbacks) are not inherited by unknown ids: a relay or an
 * older model may reject them.
 */
const DIALECT_COMPAT_KEYS = [
  'thinkingFormat',
  'maxTokensField',
  'supportsDeveloperRole',
  'supportsStore',
  'supportsReasoningEffort',
  'supportsStrictMode',
  'supportsUsageInStreaming',
  'requiresReasoningContentOnAssistantMessages',
  'thinkingTokenBudgetField',
  'chatTemplateKwargs',
  'sendSessionAffinityHeaders',
  'sessionAffinityFormat',
] as const;

/** Template for an unknown id: a model speaking the provider's main protocol. */
function providerTemplate(models: readonly PiModel[]): PiModel {
  const counts = new Map<string, number>();
  for (const model of models) counts.set(model.api, (counts.get(model.api) ?? 0) + 1);
  const main = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  const template = models.find((model) => model.api === main)!;
  const compat = (template.compat ?? {}) as Record<string, unknown>;
  const dialect = Object.fromEntries(
    DIALECT_COMPAT_KEYS.filter((key) => compat[key] !== undefined).map((key) => [key, compat[key]]),
  );
  return { ...template, compat: dialect } as PiModel;
}

function customTemplate(
  providerId: string,
  modelId: string,
  api: WireApi,
  compat: Readonly<Record<string, unknown>> | undefined,
): PiModel {
  return {
    id: modelId,
    name: modelId,
    api,
    provider: providerId,
    baseUrl: '',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: UNKNOWN_MODEL_MAX_TOKENS,
    ...(compat ? { compat: { ...compat } } : {}),
  } as PiModel;
}

export async function buildModelSpec(input: ModelSpecInput): Promise<ModelSpec> {
  const { providerId, modelId } = input;
  const descriptor = getDescriptor(providerId);
  const reviewed = findReviewed(providerId, modelId);
  const hint = modelHint(providerId, modelId);
  const legacyProvider = Boolean(REVIEWED_MODELS[providerId]);
  let capability: ThinkingCapability | undefined =
    reviewed?.capabilities?.thinking ?? reviewedThinkingCapability(providerId, modelId);
  capability ??= hint?.thinking;
  const allowedApis = descriptor?.allowedApis;
  const explicitApi =
    input.api && (!descriptor || allowedApis?.includes(input.api)) ? input.api : undefined;

  let base: PiModel;
  let upstream: 'pi' | 'custom';
  let foundInPi = false;
  let inlineThinkTags = descriptor?.inlineThinkTags ?? false;

  if (descriptor?.upstream.kind === 'pi') {
    const piProviderId = await piProviderFor(
      descriptor as ProviderDescriptor & { upstream: { kind: 'pi' } },
      input.baseUrl,
      input.endpointProfile,
    );
    const piModels = (await loadPiProvider(piProviderId)).getModels();
    const canonical = getCanonicalModelId(providerId, modelId);
    const found =
      piModels.find((model) => model.id === modelId) ??
      piModels.find((model) => model.id === canonical);
    foundInPi = Boolean(found);
    base = found
      ? { ...found, id: modelId }
      : ({
          ...providerTemplate(piModels),
          id: modelId,
          name: modelId,
          reasoning: false,
          thinkingLevelMap: undefined,
          maxTokens: UNKNOWN_MODEL_MAX_TOKENS,
        } as PiModel);
    const wantedApi =
      explicitApi ??
      hint?.api ??
      (providerId === 'openai' ? openaiDefaultApi(modelId) : (base.api as WireApi));
    if (wantedApi !== base.api) {
      // pi's provider speaks one protocol; another one needs a descriptor-built provider.
      upstream = 'custom';
      base = { ...base, api: wantedApi, compat: undefined } as PiModel;
    } else {
      upstream = 'pi';
    }
    // A relay in the OpenAI slot is an OpenAI-compatible gateway (legacy compat transport).
    if (
      providerId === 'openai' &&
      base.api === 'openai-completions' &&
      input.baseUrl &&
      hostOf(input.baseUrl) !== 'api.openai.com'
    ) {
      inlineThinkTags = true;
    }
  } else if (descriptor?.upstream.kind === 'custom') {
    const api = explicitApi ?? descriptor.upstream.api;
    base = customTemplate(providerId, modelId, api, descriptor.upstream.compat);
    upstream = 'custom';
  } else {
    // User-defined provider (`custom-*`): the connection names the protocol.
    if (!input.api) throw new ModelSpecError(descriptor ? 'missing-api' : 'unknown-provider');
    // A user-defined endpoint must go through the gateway transport: only the
    // OpenAI / Anthropic protocols (never Google / Bedrock SDK transports, P2-6).
    if (!CUSTOM_PROVIDER_APIS.includes(input.api)) throw new ModelSpecError('unsupported-api');
    if (!input.baseUrl) throw new ModelSpecError('missing-endpoint');
    base = customTemplate(providerId, modelId, input.api, undefined);
    upstream = 'custom';
    inlineThinkTags = input.api === 'openai-completions';
  }

  // Reviewed overlay.
  const reviewedVision = reviewed?.capabilities?.vision;
  const thinkingOn = Boolean(capability?.control && capability.control !== 'none');
  const levelMap = adapterLevelMap(capability);
  const compatibleEndpoint =
    upstream === 'custom' && base.api === 'openai-completions' && providerId !== 'openai';
  const compat: Record<string, unknown> = {
    ...(compatibleEndpoint ? COMPATIBLE_ENDPOINT_DEFAULTS : {}),
    ...((base.compat as Record<string, unknown> | undefined) ?? {}),
    ...(descriptor?.upstream.kind === 'pi' ? (descriptor.upstream.compat ?? {}) : {}),
    ...(upstream === 'custom' || hint ? adapterCompat(capability) : {}),
    ...(hint?.compat ?? {}),
  };
  if (base.api === 'openai-completions' && capability?.control && capability.control !== 'effort') {
    // Toggle / budget capabilities never sent an effort (legacy GLM 5.1, MiMo, …).
    compat.supportsReasoningEffort = false;
  }
  const model = {
    ...base,
    name: reviewed?.name ?? base.name,
    reasoning: thinkingOn || (foundInPi && base.reasoning),
    input:
      reviewedVision === undefined
        ? base.input
        : reviewedVision
          ? (['text', 'image'] as const)
          : (['text'] as const),
    contextWindow: reviewed?.contextWindow ?? base.contextWindow,
    maxTokens: reviewed?.outputWindow ?? base.maxTokens,
    ...(levelMap ? { thinkingLevelMap: { ...(base.thinkingLevelMap ?? {}), ...levelMap } } : {}),
    ...(Object.keys(compat).length > 0 ? { compat } : {}),
  } as PiModel;

  const endpoint = input.baseUrl ?? descriptor?.defaultBaseUrl ?? base.baseUrl;
  const resolved = {
    ...model,
    baseUrl: endpoint ? normalizeBaseUrl(model.api, providerId, endpoint) : '',
  } as PiModel;

  const knownModel = Boolean(reviewed) || foundInPi;
  if (!legacyProvider && !capability && foundInPi) capability = deriveThinkingCapability(base);
  return {
    model: resolved,
    upstream,
    inlineThinkTags,
    descriptor,
    capabilities: {
      tools: reviewed?.capabilities?.tools ?? (knownModel ? true : 'unknown'),
      vision: resolved.input.includes('image'),
      reasoning: resolved.reasoning,
      contextWindow: resolved.contextWindow,
      ...(knownModel ? { maxOutputTokens: resolved.maxTokens } : {}),
      knownModel,
      ...(capability ? { thinking: capability } : {}),
    },
  };
}
