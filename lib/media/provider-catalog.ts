import type {
  BuiltInImageProviderId,
  BuiltInVideoProviderId,
  ImageProtocol,
  ImageProviderConfig,
  ImageProviderId,
  ImageProviderSettings,
  VideoProtocol,
  VideoProviderConfig,
  VideoProviderId,
  VideoProviderSettings,
} from './types';
import { isMediaProviderUsable, isProviderUsable } from '@/lib/store/settings-validation';

const IMAGE_PROTOCOLS = new Set<ImageProtocol>([
  'openai-images',
  'siliconflow-images',
  'openrouter-images',
]);
const VIDEO_PROTOCOLS = new Set<VideoProtocol>(['siliconflow-video', 'openrouter-video']);

const IMAGE_ASPECT_RATIOS: ImageProviderConfig['supportedAspectRatios'] = [
  '16:9',
  '4:3',
  '1:1',
  '9:16',
];
const VIDEO_ASPECT_RATIOS: VideoProviderConfig['supportedAspectRatios'] = [
  '16:9',
  '4:3',
  '1:1',
  '9:16',
  '3:4',
  '21:9',
];

type ImageBuiltInCatalog = Readonly<Partial<Record<BuiltInImageProviderId, ImageProviderConfig>>>;
type VideoBuiltInCatalog = Readonly<Partial<Record<BuiltInVideoProviderId, VideoProviderConfig>>>;
type ImageSettingsMap = Readonly<Partial<Record<string, ImageProviderSettings>>>;
type VideoSettingsMap = Readonly<Partial<Record<string, VideoProviderSettings>>>;

export type MediaActivationFailureReason =
  | 'no-provider'
  | 'provider-disabled'
  | 'missing-credentials'
  | 'no-model';

export type MediaActivationResult<T extends string> =
  | { ok: true; providerId: T; modelId: string }
  | { ok: false; reason: MediaActivationFailureReason };

function resolvedModels<T extends { id: string; name: string }>(
  catalogModels: readonly T[],
  settings?: { customModels?: T[]; replaceBuiltInModels?: boolean },
): T[] {
  const customModels = settings?.customModels ?? [];
  return settings?.replaceBuiltInModels && customModels.length > 0
    ? [...customModels]
    : [...catalogModels, ...customModels];
}

function activationFailure(flags: {
  provider: boolean;
  enabledByOperator: boolean;
  credential: boolean;
  model: boolean;
}): MediaActivationResult<never> {
  if (!flags.provider) return { ok: false, reason: 'no-provider' };
  if (!flags.enabledByOperator) return { ok: false, reason: 'provider-disabled' };
  if (!flags.credential) return { ok: false, reason: 'missing-credentials' };
  return { ok: false, reason: 'no-model' };
}

export function isImageProtocol(value: unknown): value is ImageProtocol {
  return typeof value === 'string' && IMAGE_PROTOCOLS.has(value as ImageProtocol);
}

export function isVideoProtocol(value: unknown): value is VideoProtocol {
  return typeof value === 'string' && VIDEO_PROTOCOLS.has(value as VideoProtocol);
}

export function isCustomImageProviderId(value: string): value is `custom-image-${string}` {
  return value.startsWith('custom-image-') && value.length > 'custom-image-'.length;
}

export function isCustomVideoProviderId(value: string): value is `custom-video-${string}` {
  return value.startsWith('custom-video-') && value.length > 'custom-video-'.length;
}

function customImageProvider(
  id: string,
  settings: ImageProviderSettings | undefined,
): ImageProviderConfig | undefined {
  if (
    !isCustomImageProviderId(id) ||
    !settings ||
    settings.isBuiltIn !== false ||
    !settings.customName?.trim() ||
    !isImageProtocol(settings.protocol) ||
    typeof settings.requiresApiKey !== 'boolean'
  ) {
    return undefined;
  }

  return {
    id,
    name: settings.customName,
    customName: settings.customName,
    isBuiltIn: false,
    protocol: settings.protocol,
    requiresApiKey: settings.requiresApiKey,
    defaultBaseUrl: settings.baseUrl,
    models: [...(settings.customModels ?? [])],
    supportedAspectRatios: [...IMAGE_ASPECT_RATIOS],
  };
}

function customVideoProvider(
  id: string,
  settings: VideoProviderSettings | undefined,
): VideoProviderConfig | undefined {
  if (
    !isCustomVideoProviderId(id) ||
    !settings ||
    settings.isBuiltIn !== false ||
    !settings.customName?.trim() ||
    !isVideoProtocol(settings.protocol) ||
    typeof settings.requiresApiKey !== 'boolean'
  ) {
    return undefined;
  }

  return {
    id,
    name: settings.customName,
    customName: settings.customName,
    isBuiltIn: false,
    protocol: settings.protocol,
    requiresApiKey: settings.requiresApiKey,
    defaultBaseUrl: settings.baseUrl,
    models: [...(settings.customModels ?? [])],
    supportedAspectRatios: [...VIDEO_ASPECT_RATIOS],
  };
}

export function findImageProvider(
  id: ImageProviderId,
  builtIns: ImageBuiltInCatalog,
  settings: ImageSettingsMap,
): ImageProviderConfig | undefined {
  if (isCustomImageProviderId(id)) return customImageProvider(id, settings[id]);
  const provider = builtIns[id];
  return provider ? { ...provider, isBuiltIn: true } : undefined;
}

export function findVideoProvider(
  id: VideoProviderId,
  builtIns: VideoBuiltInCatalog,
  settings: VideoSettingsMap,
): VideoProviderConfig | undefined {
  if (isCustomVideoProviderId(id)) return customVideoProvider(id, settings[id]);
  const provider = builtIns[id];
  return provider ? { ...provider, isBuiltIn: true } : undefined;
}

export function listImageProviders(
  builtIns: ImageBuiltInCatalog,
  settings: ImageSettingsMap,
): ImageProviderConfig[] {
  const result: ImageProviderConfig[] = Object.values(builtIns).map((provider) => ({
    ...provider,
    isBuiltIn: true,
  }));
  for (const [id, config] of Object.entries(settings)) {
    const provider = customImageProvider(id, config);
    if (provider) result.push(provider);
  }
  return result;
}

export function listVideoProviders(
  builtIns: VideoBuiltInCatalog,
  settings: VideoSettingsMap,
): VideoProviderConfig[] {
  const result: VideoProviderConfig[] = Object.values(builtIns).map((provider) => ({
    ...provider,
    isBuiltIn: true,
  }));
  for (const [id, config] of Object.entries(settings)) {
    const provider = customVideoProvider(id, config);
    if (provider) result.push(provider);
  }
  return result;
}

/** Resolve the complete state transition for explicitly enabling image media. */
export function resolveImageActivation(
  currentProviderId: ImageProviderId | '',
  currentModelId: string,
  builtIns: ImageBuiltInCatalog,
  settings: ImageSettingsMap,
): MediaActivationResult<ImageProviderId> {
  const ids = [
    ...(currentProviderId ? [currentProviderId] : []),
    ...listImageProviders(builtIns, settings).map((provider) => provider.id),
  ].filter((id, index, all) => all.indexOf(id) === index);
  const flags = { provider: false, enabledByOperator: false, credential: false, model: false };
  for (const id of ids) {
    const provider = findImageProvider(id, builtIns, settings);
    const config = settings[id];
    if (!provider || !config) continue;
    flags.provider = true;
    if (config.serverDisabled) continue;
    flags.enabledByOperator = true;
    const hasCredential =
      isProviderUsable({
        ...config,
        requiresApiKey: provider.requiresApiKey,
        baseUrl: config.baseUrl || provider.defaultBaseUrl,
      }) &&
      (!isCustomImageProviderId(id) || !!config.baseUrl?.trim());
    if (!hasCredential) continue;
    flags.credential = true;
    const models = resolvedModels(provider.models, config);
    if (!models.length) continue;
    flags.model = true;
    return {
      ok: true,
      providerId: id,
      modelId: models.some((model) => model.id === currentModelId) ? currentModelId : models[0].id,
    };
  }
  return activationFailure(flags);
}

/** Resolve the complete state transition for explicitly enabling video media. */
export function resolveVideoActivation(
  currentProviderId: VideoProviderId | '',
  currentModelId: string,
  builtIns: VideoBuiltInCatalog,
  settings: VideoSettingsMap,
): MediaActivationResult<VideoProviderId> {
  const ids = [
    ...(currentProviderId ? [currentProviderId] : []),
    ...listVideoProviders(builtIns, settings).map((provider) => provider.id),
  ].filter((id, index, all) => all.indexOf(id) === index);
  const flags = { provider: false, enabledByOperator: false, credential: false, model: false };
  for (const id of ids) {
    const provider = findVideoProvider(id, builtIns, settings);
    const config = settings[id];
    if (!provider || !config) continue;
    flags.provider = true;
    if (config.serverDisabled) continue;
    flags.enabledByOperator = true;
    const hasCredential =
      isProviderUsable({
        ...config,
        requiresApiKey: provider.requiresApiKey,
        baseUrl: config.baseUrl || provider.defaultBaseUrl,
      }) &&
      (!isCustomVideoProviderId(id) || !!config.baseUrl?.trim());
    if (!hasCredential) continue;
    flags.credential = true;
    const models = resolvedModels(provider.models, config);
    if (!models.length) continue;
    flags.model = true;
    return {
      ok: true,
      providerId: id,
      modelId: models.some((model) => model.id === currentModelId) ? currentModelId : models[0].id,
    };
  }
  return activationFailure(flags);
}

export const mergeImageProviderCatalog = listImageProviders;
export const mergeVideoProviderCatalog = listVideoProviders;

export function isImageProviderAvailable(
  id: ImageProviderId,
  builtIns: ImageBuiltInCatalog,
  settings: ImageSettingsMap,
): boolean {
  const provider = findImageProvider(id, builtIns, settings);
  const config = settings[id];
  if (
    !provider ||
    !config ||
    !isMediaProviderUsable({
      ...config,
      requiresApiKey: provider.requiresApiKey,
      baseUrl: config.baseUrl || provider.defaultBaseUrl,
    })
  ) {
    return false;
  }
  return !isCustomImageProviderId(id) || (!!config.baseUrl?.trim() && provider.models.length > 0);
}

export function isVideoProviderAvailable(
  id: VideoProviderId,
  builtIns: VideoBuiltInCatalog,
  settings: VideoSettingsMap,
): boolean {
  const provider = findVideoProvider(id, builtIns, settings);
  const config = settings[id];
  if (
    !provider ||
    !config ||
    !isMediaProviderUsable({
      ...config,
      requiresApiKey: provider.requiresApiKey,
      baseUrl: config.baseUrl || provider.defaultBaseUrl,
    })
  ) {
    return false;
  }
  return !isCustomVideoProviderId(id) || (!!config.baseUrl?.trim() && provider.models.length > 0);
}
