import {
  PlatformDefaultModelError,
  isServerConfiguredProvider,
  isServerProviderDisabled,
  resolveImageApiKey,
  resolveImageBaseUrl,
  resolveImageModel,
  resolvePlatformDefault,
  resolveTTSApiKey,
  resolveTTSBaseUrl,
  resolveTTSModel,
  resolveVideoApiKey,
  resolveVideoBaseUrl,
  resolveVideoModel,
} from '@/lib/server/provider-config';
import type { PlatformDefaultCapability } from '@/lib/types/platform-default-models';
import {
  findLegacyPlatformDefault,
  isLegacyPlatformBacking,
} from '@/lib/server/platform-default-models';

type MediaCapability = Exclude<PlatformDefaultCapability, 'text'>;
export type ProviderSelectionSource = 'platform' | 'user' | 'legacy-managed';

export class ProviderSelectionError extends Error {
  constructor(
    readonly code:
      | PlatformDefaultModelError['code']
      | 'INVALID_MODEL_SOURCE'
      | 'MISSING_PROVIDER'
      | 'PROVIDER_DISABLED',
    readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderSelectionError';
  }
}

export interface ResolvedProviderSelection {
  source: ProviderSelectionSource;
  providerId: string;
  modelId?: string;
  apiKey: string;
  baseUrl?: string;
  managed: boolean;
  defaultId?: string;
  revision?: string;
  platformParameters?: ReturnType<typeof resolvePlatformDefault>['parameters'];
}

/** Convert the public platform image policy into the provider adapter contract. */
export function platformImageExecutionOptions(selection: ResolvedProviderSelection): { n: 1 } {
  if (selection.source !== 'platform' || selection.platformParameters?.imageCount !== 1) {
    throw new ProviderSelectionError(
      'INVALID_MODEL_SOURCE',
      500,
      'The platform image default has invalid execution parameters',
    );
  }
  return { n: selection.platformParameters.imageCount };
}

/** Convert the public 768P platform policy to the shared adapter's 720p tier. */
export function platformVideoExecutionOptions(selection: ResolvedProviderSelection): {
  duration: 6;
  resolution: '720p';
} {
  const parameters = selection.platformParameters;
  if (
    selection.source !== 'platform' ||
    parameters?.videoDurationSeconds !== 6 ||
    parameters.videoResolution !== '768P'
  ) {
    throw new ProviderSelectionError(
      'INVALID_MODEL_SOURCE',
      500,
      'The platform video default has invalid execution parameters',
    );
  }
  return { duration: parameters.videoDurationSeconds, resolution: '720p' };
}

export function normalizeProviderSelectionSource(value?: string): ProviderSelectionSource {
  if (!value) return 'legacy-managed';
  if (value === 'platform' || value === 'user' || value === 'legacy-managed') return value;
  throw new ProviderSelectionError('INVALID_MODEL_SOURCE', 400, `Invalid model source: ${value}`);
}

/** Resolve one media request without ever crossing the platform/user credential boundary. */
export function resolveProviderSelection(input: {
  capability: MediaCapability;
  source?: string;
  defaultId?: string;
  providerId?: string;
  modelId?: string;
  apiKey?: string;
  baseUrl?: string;
  voiceId?: string;
}): ResolvedProviderSelection {
  const source = normalizeProviderSelectionSource(input.source);
  if (source === 'platform') {
    if (!input.defaultId) {
      throw new ProviderSelectionError(
        'INVALID_MODEL_SOURCE',
        400,
        'A platform model selection requires a platform default ID',
      );
    }
    try {
      const binding = resolvePlatformDefault(input.defaultId, input.capability);
      return {
        source,
        providerId: binding.providerId,
        modelId: binding.modelId,
        apiKey: binding.apiKey,
        baseUrl: binding.baseUrl,
        managed: true,
        defaultId: binding.defaultId,
        revision: binding.revision,
        platformParameters: binding.parameters,
      };
    } catch (error) {
      if (error instanceof PlatformDefaultModelError) {
        throw new ProviderSelectionError(error.code, error.httpStatus, error.message);
      }
      throw error;
    }
  }

  const providerId = input.providerId?.trim();
  if (!providerId) {
    throw new ProviderSelectionError('MISSING_PROVIDER', 400, 'No provider selected');
  }
  if (isServerProviderDisabled(input.capability, providerId)) {
    throw new ProviderSelectionError(
      'PROVIDER_DISABLED',
      403,
      `This ${input.capability} provider is disabled by the server`,
    );
  }

  // Explicit user selections are isolated from same-named server entries.
  if (source === 'user') {
    return {
      source,
      providerId,
      modelId: input.modelId,
      apiKey: input.apiKey || '',
      baseUrl: input.baseUrl,
      managed: false,
    };
  }

  const managed = isServerConfiguredProvider(input.capability, providerId);
  if (managed && isLegacyPlatformBacking(input.capability, providerId)) {
    const legacyDefault = findLegacyPlatformDefault(input.capability, providerId, input.modelId);
    if (!legacyDefault) {
      throw new ProviderSelectionError(
        'INVALID_MODEL_SOURCE',
        400,
        `Legacy platform credentials cannot be used with model ${input.modelId || '(missing)'}`,
      );
    }
    return resolveProviderSelection({
      capability: input.capability,
      source: 'platform',
      defaultId: legacyDefault.defaultId,
    });
  }
  switch (input.capability) {
    case 'image':
      return {
        source,
        providerId,
        modelId: resolveImageModel(providerId, input.modelId),
        apiKey: resolveImageApiKey(providerId, managed ? undefined : input.apiKey),
        baseUrl: resolveImageBaseUrl(providerId, managed ? undefined : input.baseUrl),
        managed,
      };
    case 'video':
      return {
        source,
        providerId,
        modelId: resolveVideoModel(providerId, input.modelId),
        apiKey: resolveVideoApiKey(providerId, managed ? undefined : input.apiKey),
        baseUrl: resolveVideoBaseUrl(providerId, managed ? undefined : input.baseUrl),
        managed,
      };
    case 'tts':
      return {
        source,
        providerId,
        modelId: resolveTTSModel(providerId, input.modelId, input.voiceId),
        apiKey: resolveTTSApiKey(providerId, managed ? undefined : input.apiKey),
        baseUrl: resolveTTSBaseUrl(providerId, managed ? undefined : input.baseUrl),
        managed,
      };
  }
}
