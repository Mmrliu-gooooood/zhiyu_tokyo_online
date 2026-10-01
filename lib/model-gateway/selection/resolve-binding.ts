/**
 * Selection → ModelBinding (plan P2-4). Carries over every rule of the legacy
 * resolver (lib/server/resolve-model.ts):
 *
 * - Order: configured stage route > client selection > DEFAULT_MODEL. A route
 *   ignores the client's model, key, endpoint, dialect and thinking.
 * - Platform defaults resolve only through resolvePlatformDefault(); a stale
 *   revision is 409, an unsupported thinking config 400; legacy-managed
 *   requests for the platform's backing provider map to the platform model.
 * - Operator-configured providers use the server key / endpoint / proxy and
 *   ignore client overrides; otherwise the client connection is used.
 * - Operator-only providers (Bedrock, Vertex) reject user selections.
 * - The credential lives in a private handle; the binding is frozen.
 */
import { getStageRoute, type StageRoute } from '@/lib/server/model-routes';
import {
  isServerConfiguredProvider,
  resolveApiKey,
  resolveBaseUrl,
  resolvePlatformDefault,
  resolveProxy,
  type ResolvedPlatformDefault,
} from '@/lib/server/provider-config';
import {
  findLegacyPlatformDefault,
  isLegacyPlatformBacking,
  isPlatformThinkingConfigSupported,
  normalizePlatformThinkingConfig,
} from '@/lib/server/platform-default-models';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import type { ThinkingConfig } from '@/lib/types/provider';
import { getDescriptor } from '../catalog/descriptors';
import { createBinding, type CredentialHandle } from '../credentials/handles';
import { GatewayError } from '../runtime/errors';
import type {
  EndpointKind,
  FundingSource,
  ModelBinding,
  TextPlatformDefaultId,
  WireApi,
} from '../types';
import { ModelSelectionError } from './errors';
import { buildModelSpec, ModelSpecError, type ModelSpec } from './model-spec';
import { isTextPlatformDefaultId, platformModelSpec } from './platform';
import type { RequestModelSelection } from './read-request';
import { WIRE_APIS, upgradeLegacyModelParams, type ModelSelection } from './schema';

export interface ResolveBindingInput {
  /** Result of readModelSelection() (its deferred error is thrown unless routed). */
  request?: RequestModelSelection;
  /** A stored / constructed selection (PRO connection, snapshot). */
  selection?: ModelSelection;
  /** Generation stage for MODEL_ROUTES (a gateway `source` label). */
  stage?: string;
}

const AMBIENT_APIS = new Set<string>(['bedrock-converse-stream', 'google-vertex']);

function configurationError(providerId: string, modelId: string): GatewayError {
  return new GatewayError('MODEL_CONFIGURATION', { providerId, modelId });
}

function routeApi(route: StageRoute | undefined): WireApi | undefined {
  return route?.api && (WIRE_APIS as readonly string[]).includes(route.api)
    ? (route.api as WireApi)
    : undefined;
}

interface Intent {
  selection: ModelSelection;
  modelString: string;
  routed: boolean;
  route?: StageRoute;
}

function resolveIntent(input: ResolveBindingInput): Intent {
  const route = getStageRoute(input.stage);
  if (route?.model) {
    const selection = upgradeLegacyModelParams({ modelString: route.model });
    if (!selection) throw new ModelSelectionError('MISSING_MODEL', 400, 'Invalid stage route.');
    return { selection, modelString: route.model, routed: true, route };
  }
  if (input.request?.error) throw input.request.error;
  const selection = input.selection ?? input.request?.selection;
  if (selection) {
    return {
      selection,
      modelString:
        selection.source === 'platform'
          ? `platform:${selection.defaultId}`
          : `${selection.providerId}:${selection.modelId}`,
      routed: false,
    };
  }
  const fallback = process.env.DEFAULT_MODEL?.trim();
  if (!fallback) {
    throw new ModelSelectionError(
      'MISSING_MODEL',
      400,
      'No model could be resolved. Configure DEFAULT_MODEL (and/or a MODEL_ROUTES entry for this stage), or send a model via x-model.',
    );
  }
  const defaultSelection = upgradeLegacyModelParams({
    modelString: fallback,
    thinkingConfig: input.request?.thinking,
  })!;
  return { selection: defaultSelection, modelString: fallback, routed: false };
}

async function platformBinding(
  intent: Intent,
  platform: ResolvedPlatformDefault,
  requested: { revision?: string; thinking?: ThinkingConfig },
  stage: string | undefined,
): Promise<ModelBinding> {
  if (!intent.routed && requested.revision && requested.revision !== platform.revision) {
    throw new ModelSelectionError(
      'PLATFORM_DEFAULT_REVISION_MISMATCH',
      409,
      'The platform default model revision has changed. Refresh the model catalog and retry.',
    );
  }
  if (
    !intent.routed &&
    requested.thinking &&
    !isPlatformThinkingConfigSupported(platform.parameters, requested.thinking)
  ) {
    throw new ModelSelectionError(
      'INVALID_MODEL_SOURCE',
      400,
      'The selected platform model does not support this thinking configuration.',
    );
  }
  const thinking = intent.routed
    ? (intent.route?.thinking ??
      normalizePlatformThinkingConfig(
        platform.parameters,
        undefined,
        platform.defaultThinkingConfig,
      ))
    : normalizePlatformThinkingConfig(
        platform.parameters,
        requested.thinking,
        platform.defaultThinkingConfig,
      );
  if (!isTextPlatformDefaultId(platform.defaultId)) {
    throw configurationError(platform.providerId, platform.modelId);
  }
  const defaultId: TextPlatformDefaultId = platform.defaultId;
  const spec = await specOrConfigurationError(platform.providerId, platform.modelId, () =>
    platformModelSpec(platform),
  );
  return createBinding(
    {
      source: 'platform',
      ...(intent.routed ? { routedStage: stage } : {}),
      providerId: platform.providerId,
      modelId: platform.modelId,
      modelString: intent.modelString,
      defaultId,
      revision: platform.revision,
      model: spec.model,
      upstream: spec.upstream,
      capabilities: spec.capabilities,
      transforms: {
        inlineThinkTags: spec.inlineThinkTags,
        payloadPatches: spec.descriptor?.payloadPatches ?? [],
      },
      ...(thinking ? { thinking } : {}),
      funding: { kind: 'platform', defaultId, revision: platform.revision },
      endpoint: platform.baseUrl ? 'operator' : 'official',
      ...(platform.proxy ? { proxy: platform.proxy } : {}),
    },
    { kind: 'platform', defaultId, revision: platform.revision, apiKey: platform.apiKey },
  );
}

async function specOrConfigurationError(
  providerId: string,
  modelId: string,
  build: () => Promise<ModelSpec>,
): Promise<ModelSpec> {
  try {
    return await build();
  } catch (error) {
    if (error instanceof ModelSpecError) throw configurationError(providerId, modelId);
    throw error;
  }
}

export async function resolveBinding(input: ResolveBindingInput): Promise<ModelBinding> {
  const intent = resolveIntent(input);
  const { selection, routed } = intent;

  if (selection.source === 'platform') {
    const platform = resolvePlatformDefault(selection.defaultId, 'text');
    return platformBinding(
      intent,
      platform,
      { revision: selection.revision, thinking: selection.thinking },
      input.stage,
    );
  }

  const { providerId, modelId } = selection;
  const operatorConfigured = isServerConfiguredProvider('providers', providerId);
  if (
    !routed &&
    selection.source === 'legacy-managed' &&
    operatorConfigured &&
    isLegacyPlatformBacking('text', providerId)
  ) {
    const legacyDefault = findLegacyPlatformDefault('text', providerId, modelId);
    if (!legacyDefault) {
      throw new ModelSelectionError(
        'INVALID_MODEL_SOURCE',
        400,
        `Legacy platform credentials cannot be used with model ${modelId}`,
      );
    }
    return platformBinding(
      intent,
      resolvePlatformDefault(legacyDefault.defaultId, 'text'),
      { thinking: selection.thinking },
      input.stage,
    );
  }

  const managed = selection.source === 'legacy-managed' && operatorConfigured;
  const connection = managed ? undefined : selection.connection;
  const descriptor = getDescriptor(providerId);
  if (descriptor && !descriptor.userConfigurable && !managed) {
    throw configurationError(providerId, modelId);
  }
  const connectionApi = connection && 'api' in connection ? connection.api : undefined;
  if (!managed && connectionApi && AMBIENT_APIS.has(connectionApi)) {
    throw configurationError(providerId, modelId);
  }
  if (connection?.auth === 'credential') {
    // Subscription credentials arrive with the R2 credential vault (P6).
    throw configurationError(providerId, modelId);
  }

  const clientBaseUrl = connection && 'baseUrl' in connection ? connection.baseUrl : undefined;
  if (clientBaseUrl && descriptor && !descriptor.allowCustomBaseUrl) {
    throw new GatewayError('MODEL_UNSAFE_ENDPOINT', { providerId, modelId });
  }
  if (clientBaseUrl && process.env.NODE_ENV === 'production') {
    if (await validateUrlForSSRF(clientBaseUrl)) {
      throw new GatewayError('MODEL_UNSAFE_ENDPOINT', { providerId, modelId });
    }
  }

  const keyless = Boolean(
    descriptor?.auth.includes('none') || descriptor?.auth.includes('ambient'),
  );
  let handle: CredentialHandle;
  let baseUrl: string | undefined;
  let proxy: string | undefined;
  let endpoint: EndpointKind;
  let funding: FundingSource;
  if (managed) {
    const key = resolveApiKey(providerId);
    handle = { kind: 'operator', providerId, apiKey: keyless && !key ? undefined : key };
    baseUrl = resolveBaseUrl(providerId);
    proxy = resolveProxy(providerId);
    endpoint = 'operator';
    funding = { kind: 'operator' };
  } else if (connection?.auth === 'api-key') {
    handle = { kind: 'inline-key', apiKey: connection.apiKey };
    baseUrl = connection.baseUrl;
    endpoint = baseUrl ? 'user' : keyless ? 'local' : 'official';
    funding = { kind: 'byok' };
  } else {
    // Keyless (local) connection, or a legacy-managed selection without one.
    handle =
      keyless || connection?.auth === 'none'
        ? { kind: 'none' }
        : { kind: 'inline-key', apiKey: '' };
    baseUrl = connection?.auth === 'none' ? connection.baseUrl : undefined;
    endpoint = baseUrl ? 'user' : keyless ? 'local' : 'official';
    funding = handle.kind === 'none' ? { kind: 'local' } : { kind: 'byok' };
  }
  if (descriptor?.requiresBaseUrl && !baseUrl) throw configurationError(providerId, modelId);

  const spec = await specOrConfigurationError(providerId, modelId, () =>
    buildModelSpec({
      providerId,
      modelId,
      api: routed ? routeApi(intent.route) : connectionApi,
      baseUrl,
      endpointProfile:
        connection && 'endpointProfile' in connection ? connection.endpointProfile : undefined,
    }),
  );

  // Non-secret endpoint values pi substitutes into the URL (Cloudflare account / gateway).
  const declared = spec.descriptor?.endpointParams ?? [];
  const provided =
    connection?.auth === 'api-key'
      ? (connection.endpointParams ?? {})
      : ({} as Record<string, string>);
  const requestEnv = Object.fromEntries(
    declared.filter((name) => provided[name]).map((name) => [name, provided[name]!]),
  );
  const endpointReady = declared.every((name) => requestEnv[name]);

  const thinking: ThinkingConfig | undefined = routed ? intent.route?.thinking : selection.thinking;
  return createBinding(
    {
      source: selection.source,
      ...(routed ? { routedStage: input.stage } : {}),
      providerId,
      modelId,
      modelString: intent.modelString,
      model: spec.model,
      upstream: spec.upstream,
      capabilities: spec.capabilities,
      transforms: {
        inlineThinkTags: spec.inlineThinkTags,
        payloadPatches: spec.descriptor?.payloadPatches ?? [],
        ...(spec.descriptor?.bearerKeyPrefixes
          ? { bearerKeyPrefixes: spec.descriptor.bearerKeyPrefixes }
          : {}),
      },
      ...(thinking ? { thinking } : {}),
      funding,
      endpoint,
      ...(endpoint === 'operator' && proxy ? { proxy } : {}),
      ...(Object.keys(requestEnv).length > 0 ? { requestEnv } : {}),
    },
    handle,
    endpointReady,
  );
}

/** Client-facing status for resolution failures (legacy getModelResolutionError shape). */
export function getBindingResolutionError(
  error: unknown,
): { code: string; httpStatus: number; message: string } | undefined {
  if (error instanceof ModelSelectionError) {
    return { code: error.code, httpStatus: error.httpStatus, message: error.message };
  }
  if (error && typeof error === 'object' && (error as Error).name === 'PlatformDefaultModelError') {
    const platform = error as Error & { code: string; httpStatus: number };
    return { code: platform.code, httpStatus: platform.httpStatus, message: platform.message };
  }
  if (error instanceof GatewayError) {
    if (error.code === 'MODEL_CONFIGURATION' || error.code === 'MODEL_UNSAFE_ENDPOINT') {
      return { code: error.code, httpStatus: 400, message: error.message };
    }
  }
  return undefined;
}
