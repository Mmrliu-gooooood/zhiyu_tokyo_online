/**
 * Shared model resolution utilities for API routes.
 *
 * Extracts the repeated parseModelString → resolveApiKey → resolveBaseUrl →
 * resolveProxy → getModel boilerplate into a single call.
 */

import type { NextRequest } from 'next/server';
import {
  getModel,
  getProvider,
  parseModelString,
  normalizeModelApi,
  type ModelWithInfo,
} from '@/lib/ai/providers';
import type { ModelConfig } from '@/lib/types/provider';
import type { ProviderId, ProviderType, ThinkingConfig } from '@/lib/types/provider';
import {
  isServerConfiguredProvider,
  resolveApiKey,
  resolveBaseUrl,
  PlatformDefaultModelError,
  resolvePlatformDefault,
  resolveProxy,
} from '@/lib/server/provider-config';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import { getStageRoute, type LlmStage } from '@/lib/server/model-routes';
import {
  findLegacyPlatformDefault,
  isLegacyPlatformBacking,
  isPlatformThinkingConfigSupported,
  normalizePlatformThinkingConfig,
} from '@/lib/server/platform-default-models';

export class ModelSelectionError extends Error {
  constructor(
    readonly code: 'INVALID_MODEL_SOURCE' | 'MISSING_MODEL' | 'PLATFORM_DEFAULT_REVISION_MISMATCH',
    readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = 'ModelSelectionError';
  }
}

export function getModelResolutionError(error: unknown):
  | {
      code: ModelSelectionError['code'] | PlatformDefaultModelError['code'];
      httpStatus: number;
      message: string;
    }
  | undefined {
  if (error instanceof ModelSelectionError || error instanceof PlatformDefaultModelError) {
    return { code: error.code, httpStatus: error.httpStatus, message: error.message };
  }
  return undefined;
}

export interface ResolvedModel extends ModelWithInfo {
  /** Original model string (e.g. "openai/gpt-4o-mini") */
  modelString: string;
  /** Resolved provider ID (e.g. "openai", "ollama") */
  providerId: string;
  /** Resolved model ID (e.g. "gpt-4o-mini") */
  modelId: string;
  /** Effective API key after server-side fallback resolution */
  apiKey: string;
  /** Effective base URL after server/client resolution */
  baseUrl?: string;
  /** Optional per-request thinking configuration from the client. */
  thinkingConfig?: ThinkingConfig;
  source: 'platform' | 'user' | 'legacy-managed';
  defaultId?: string;
  revision?: string;
}

/**
 * Resolve a language model from explicit parameters.
 *
 * Use this when model config comes from the request body.
 */
export async function resolveModel(params: {
  api?: ModelConfig['api'];
  modelString?: string;
  /**
   * Optional generation stage (a `callLLM` source label, e.g. 'scene-content').
   * When set and a route is configured via `MODEL_ROUTES`, the route wins for
   * this call — even over a client-sent `modelString` (x-model). Unrouted
   * stages fall back to `modelString` then `DEFAULT_MODEL`. See
   * lib/server/model-routes.ts.
   */
  stage?: LlmStage;
  apiKey?: string;
  baseUrl?: string;
  providerType?: string;
  thinkingConfig?: ThinkingConfig;
  source?: 'platform' | 'user' | 'legacy-managed';
  platformDefaultId?: string;
  defaultId?: string;
  revision?: string;
}): Promise<ResolvedModel> {
  // Resolution order: stage route > x-model > DEFAULT_MODEL.
  // A configured stage route is the operator's deliberate per-stage choice and
  // wins even over a client-sent x-model (otherwise the browser UI, which always
  // sends its saved model, would shadow every route). Unrouted stages fall back
  // to the client x-model, then DEFAULT_MODEL. There is intentionally no hardcoded
  // model fallback — if nothing resolves we fail loud rather than silently pick a
  // vendor default.
  const stageRoute = getStageRoute(params.stage);
  const stageModel = stageRoute?.model;
  const requestedSource = params.source as string | undefined;
  if (
    !stageModel &&
    requestedSource &&
    requestedSource !== 'platform' &&
    requestedSource !== 'user' &&
    requestedSource !== 'legacy-managed'
  ) {
    throw new ModelSelectionError(
      'INVALID_MODEL_SOURCE',
      400,
      `Invalid model source: ${requestedSource}`,
    );
  }
  if (!stageModel && params.platformDefaultId && requestedSource !== 'platform') {
    throw new ModelSelectionError(
      'INVALID_MODEL_SOURCE',
      400,
      'A platform default ID can only be used with the platform model source.',
    );
  }
  const selectedPlatformDefaultId =
    !stageModel && params.source === 'platform'
      ? params.platformDefaultId || params.defaultId
      : undefined;
  const modelString =
    stageModel ||
    (selectedPlatformDefaultId ? `platform:${selectedPlatformDefaultId}` : params.modelString) ||
    process.env.DEFAULT_MODEL;
  if (!modelString) {
    throw new ModelSelectionError(
      'MISSING_MODEL',
      400,
      'No model could be resolved. Configure DEFAULT_MODEL (and/or a MODEL_ROUTES entry for this stage), or send a model via x-model.',
    );
  }
  const routed = Boolean(stageModel);
  let platformDefaultId = modelString.startsWith('platform:')
    ? modelString.slice('platform:'.length)
    : !routed && params.source === 'platform'
      ? params.platformDefaultId || params.defaultId
      : undefined;
  if (!routed && params.source === 'platform' && !platformDefaultId) {
    throw new ModelSelectionError(
      'INVALID_MODEL_SOURCE',
      400,
      'A platform model selection requires a platform default ID.',
    );
  }
  if (!routed && params.source === 'user' && modelString.startsWith('platform:')) {
    throw new ModelSelectionError(
      'INVALID_MODEL_SOURCE',
      400,
      'A user model selection cannot reference a platform default.',
    );
  }
  let platformBinding = platformDefaultId
    ? resolvePlatformDefault(platformDefaultId, 'text')
    : undefined;
  if (
    !routed &&
    platformBinding &&
    params.revision &&
    params.revision !== platformBinding.revision
  ) {
    throw new ModelSelectionError(
      'PLATFORM_DEFAULT_REVISION_MISMATCH',
      409,
      'The platform default model revision has changed. Refresh the model catalog and retry.',
    );
  }
  if (!platformBinding && !routed && params.source !== 'user') {
    const legacy = parseModelString(modelString);
    if (
      isServerConfiguredProvider('providers', legacy.providerId) &&
      isLegacyPlatformBacking('text', legacy.providerId)
    ) {
      const legacyDefault = findLegacyPlatformDefault('text', legacy.providerId, legacy.modelId);
      if (!legacyDefault) {
        throw new ModelSelectionError(
          'INVALID_MODEL_SOURCE',
          400,
          `Legacy platform credentials cannot be used with model ${legacy.modelId}`,
        );
      }
      platformDefaultId = legacyDefault.defaultId;
      platformBinding = resolvePlatformDefault(platformDefaultId, 'text');
    }
  }
  const parsed = platformBinding
    ? { providerId: platformBinding.providerId as ProviderId, modelId: platformBinding.modelId }
    : parseModelString(modelString);
  const { providerId, modelId } = parsed;

  // When a stage route overrides the client's model, the client-sent connection
  // params (apiKey/baseUrl/providerType) belong to the client's *other* model
  // and must not bleed onto the routed provider — otherwise e.g. a routed
  // Anthropic model would be built with the client's OpenAI providerType/key.
  // A routed model resolves purely from server config, as if no x-model was sent.
  const clientApiKey = routed ? undefined : params.apiKey;
  const clientProviderType = routed ? undefined : params.providerType;
  const clientBaseUrlParam = routed ? undefined : params.baseUrl;

  // Server-managed providers are admin-owned: the operator's key and base URL
  // are authoritative and any client-sent override is ignored. SSRF validation
  // therefore applies only to unmanaged providers, where the base URL really is
  // client-supplied. (Server-configured URLs are trusted by the operator.)
  const source = platformBinding
    ? 'platform'
    : !routed && params.source === 'user'
      ? 'user'
      : 'legacy-managed';
  const managed =
    source === 'platform' ||
    (source === 'legacy-managed' && isServerConfiguredProvider('providers', providerId));
  const registeredProviderType = getProvider(providerId)?.type;
  if (
    clientProviderType &&
    registeredProviderType &&
    clientProviderType !== registeredProviderType
  ) {
    throw new Error(
      `Provider type mismatch for ${providerId}: expected ${registeredProviderType}, received ${clientProviderType}.`,
    );
  }
  const effectiveProviderType = (clientProviderType || registeredProviderType) as
    | ProviderType
    | undefined;
  if (effectiveProviderType === 'bedrock' && (providerId !== 'bedrock' || !managed)) {
    throw new Error('Amazon Bedrock must be enabled by the server operator before it can be used.');
  }
  const clientBaseUrl = managed ? undefined : clientBaseUrlParam || undefined;
  if (clientBaseUrl && process.env.NODE_ENV === 'production') {
    const ssrfError = await validateUrlForSSRF(clientBaseUrl);
    if (ssrfError) {
      throw new Error(ssrfError);
    }
  }

  const apiKey = platformBinding
    ? platformBinding.apiKey
    : source === 'user'
      ? clientApiKey || ''
      : resolveApiKey(providerId, clientApiKey || '');
  const baseUrl = platformBinding
    ? platformBinding.baseUrl
    : source === 'user'
      ? clientBaseUrl
      : resolveBaseUrl(providerId, clientBaseUrl);
  const proxy = platformBinding
    ? platformBinding.proxy
    : source === 'user'
      ? undefined
      : resolveProxy(providerId);
  const { model, modelInfo } = getModel({
    api: normalizeModelApi(routed ? stageRoute?.api : params.api),
    providerId,
    modelId,
    apiKey,
    baseUrl,
    proxy,
    providerType: clientProviderType as ProviderType | undefined,
    ...(clientBaseUrl
      ? {
          validateRequestUrl: async (url: string) => {
            const unsafe = await validateUrlForSSRF(url);
            if (unsafe) throw new Error('PRO_MODEL_UNSAFE_ENDPOINT');
          },
        }
      : {}),
  });

  // Thinking arbitration mirrors model routing — the route carries a full
  // ThinkingConfig (mode/effort/level/enabled/budgetTokens/…) which callLLM
  // normalizes against the model's capability:
  //  - routed + thinking set → the route's thinking wins (over client thinking).
  //  - routed platform + no thinking → the reviewed platform default policy.
  //  - other routed + no thinking → the routed model's provider default; client
  //    thinking is dropped (it belonged to the client's other model).
  //  - unrouted              → honor the client's thinking config.
  if (
    !routed &&
    platformBinding &&
    params.thinkingConfig &&
    !isPlatformThinkingConfigSupported(platformBinding.parameters, params.thinkingConfig)
  ) {
    throw new ModelSelectionError(
      'INVALID_MODEL_SOURCE',
      400,
      'The selected platform model does not support this thinking configuration.',
    );
  }
  const thinkingConfig: ThinkingConfig | undefined = routed
    ? (stageRoute?.thinking ??
      (platformBinding
        ? normalizePlatformThinkingConfig(
            platformBinding.parameters,
            undefined,
            platformBinding.defaultThinkingConfig,
          )
        : undefined))
    : platformBinding
      ? normalizePlatformThinkingConfig(
          platformBinding.parameters,
          params.thinkingConfig,
          platformBinding.defaultThinkingConfig,
        )
      : params.thinkingConfig;

  return {
    model,
    modelInfo,
    modelString,
    providerId,
    modelId,
    apiKey,
    baseUrl,
    thinkingConfig,
    source,
    ...(platformBinding
      ? { defaultId: platformBinding.defaultId, revision: platformBinding.revision }
      : {}),
  };
}

function getThinkingConfigFromBody(body: unknown): ThinkingConfig | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const record = body as { thinkingConfig?: unknown; thinking?: unknown };
  const config = record.thinkingConfig ?? record.thinking;
  return config && typeof config === 'object' ? (config as ThinkingConfig) : undefined;
}

/**
 * Resolve a language model from standard request headers.
 *
 * Reads: x-model, x-api-key, x-base-url, x-provider-type
 * Note: requiresApiKey is derived server-side from the provider registry,
 * never from client headers, to prevent auth bypass.
 */
export async function resolveModelFromHeaders(
  req: NextRequest,
  stage?: LlmStage,
  thinkingConfig?: ThinkingConfig,
): Promise<ResolvedModel> {
  return resolveModel({
    modelString: req.headers.get('x-model') || undefined,
    stage,
    apiKey: req.headers.get('x-api-key') || undefined,
    baseUrl: req.headers.get('x-base-url') || undefined,
    providerType: req.headers.get('x-provider-type') || undefined,
    source:
      (req.headers.get('x-model-source') as 'platform' | 'user' | 'legacy-managed' | null) ||
      undefined,
    platformDefaultId: req.headers.get('x-platform-default-id') || undefined,
    thinkingConfig,
  });
}

/**
 * Resolve a language model from standard request headers plus body fields.
 *
 * Reads model credentials from headers and per-request thinking config from
 * the JSON body field `thinkingConfig` (or legacy/eval field `thinking`).
 */
export async function resolveModelFromRequest(
  req: NextRequest,
  body: unknown,
  stage?: LlmStage,
): Promise<ResolvedModel> {
  // Pass the client's body thinking into resolveModel so the single arbiter
  // there decides (a routed stage may override or drop it). See resolveModel.
  return resolveModelFromHeaders(req, stage, getThinkingConfigFromBody(body));
}
