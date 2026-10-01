/**
 * Build the resolved pi model for a binding: pi catalog data (or a provider
 * template for unknown ids) → reviewed overlay (names, windows, vision,
 * thinking) → request-shape compat derived from the reviewed thinking
 * capability → endpoint. Server-only.
 */
import type { ModelInfo, ThinkingCapability } from '@/lib/types/provider';
import { getCanonicalModelId } from '@/lib/ai/model-aliases';
import { getDescriptor, type ProviderDescriptor } from '../catalog/descriptors';
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
  constructor(readonly reason: 'unknown-provider' | 'missing-api' | 'missing-endpoint') {
    super(`Model cannot be resolved: ${reason}`);
    this.name = 'ModelSpecError';
  }
}

const LEVELS_FROM_CAPABILITY = ['minimal', 'xhigh', 'max'] as const;

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
    case 'qwen':
    case 'siliconflow':
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
  const map: Record<string, string> = {};
  for (const level of LEVELS_FROM_CAPABILITY) {
    if (capability.effortValues?.includes(level)) map[level] = level;
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

/** pi's Anthropic SDK appends `/v1`; legacy base URLs include it. */
function normalizeBaseUrl(api: string, providerId: string, baseUrl: string): string {
  let url = baseUrl.trim().replace(/\/+$/, '');
  if (api === 'anthropic-messages') {
    if (providerId === 'minimax' && !/\/anthropic(\/v1)?$/.test(url)) url = `${url}/anthropic`;
    url = url.replace(/\/v1$/, '');
  }
  return url;
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
    maxTokens: 8_192,
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
    const template = found ?? piModels[0]!;
    base = found
      ? { ...found, id: modelId }
      : ({
          ...template,
          id: modelId,
          name: modelId,
          reasoning: false,
          thinkingLevelMap: undefined,
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
    if (!input.baseUrl) throw new ModelSpecError('missing-endpoint');
    base = customTemplate(providerId, modelId, input.api, undefined);
    upstream = 'custom';
    inlineThinkTags = input.api === 'openai-completions';
  }

  // Reviewed overlay.
  const reviewedVision = reviewed?.capabilities?.vision;
  const thinkingOn = Boolean(capability?.control && capability.control !== 'none');
  const levelMap = adapterLevelMap(capability);
  const compat: Record<string, unknown> = {
    ...((base.compat as Record<string, unknown> | undefined) ?? {}),
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
