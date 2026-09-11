import { createHmac } from 'crypto';
import { getThinkingMode, normalizeThinkingConfig } from '@/lib/ai/thinking-config';
import type { ThinkingCapability, ThinkingConfig } from '@/lib/types/provider';
import type {
  PlatformDefaultCapability,
  PlatformDefaultCatalogEntry,
  PlatformDefaultId,
  PlatformDefaultParameters,
} from '@/lib/types/platform-default-models';

export interface PlatformDefaultOverride {
  modelId?: string;
  displayName?: string;
  enabled?: boolean;
  thinkingConfig?: ThinkingConfig;
}

export interface PlatformDefaultDefinition {
  defaultId: PlatformDefaultId;
  capability: PlatformDefaultCapability;
  section: 'providers' | 'image' | 'video' | 'tts';
  providerId: string;
  providerName: string;
  modelId: string;
  displayName: string;
  parameters: PlatformDefaultParameters;
  defaultThinkingConfig?: ThinkingConfig;
  envPrefix: string;
}

export const PLATFORM_DEFAULT_DEFINITIONS: readonly PlatformDefaultDefinition[] = [
  {
    defaultId: 'zhiyu-default-text',
    capability: 'text',
    section: 'providers',
    providerId: 'deepseek',
    providerName: 'DeepSeek',
    modelId: 'deepseek-flash',
    displayName: 'DeepSeek V4.1 Flash',
    parameters: {
      textTools: true,
      textThinking: {
        control: 'effort',
        requestAdapter: 'deepseek',
        effortValues: ['none', 'high', 'max'],
        defaultEffort: 'high',
      },
      textContextWindow: 1048576,
      textOutputWindow: 393216,
    },
    defaultThinkingConfig: { mode: 'disabled', effort: 'none' },
    envPrefix: 'ZHIYU_DEFAULT_TEXT',
  },
  {
    defaultId: 'zhiyu-default-image',
    capability: 'image',
    section: 'image',
    providerId: 'minimax-image',
    providerName: 'MiniMax',
    modelId: 'image-01',
    displayName: 'MiniMax Image-01',
    parameters: { imageCount: 1 },
    envPrefix: 'ZHIYU_DEFAULT_IMAGE',
  },
  {
    defaultId: 'zhiyu-default-video',
    capability: 'video',
    section: 'video',
    providerId: 'minimax-video',
    providerName: 'MiniMax',
    modelId: 'MiniMax-Hailuo-2.3',
    displayName: 'MiniMax Hailuo 2.3',
    parameters: { videoResolution: '768P', videoDurationSeconds: 6 },
    envPrefix: 'ZHIYU_DEFAULT_VIDEO',
  },
  {
    defaultId: 'zhiyu-default-tts',
    capability: 'tts',
    section: 'tts',
    providerId: 'minimax-tts',
    providerName: 'MiniMax',
    modelId: 'speech-2.8-turbo',
    displayName: 'MiniMax Speech 2.8 Turbo',
    parameters: { ttsVoice: 'male-qn-qingse' },
    envPrefix: 'ZHIYU_DEFAULT_TTS',
  },
] as const;

const LEGACY_PLATFORM_MODEL_ALIASES: Record<PlatformDefaultId, readonly string[]> = {
  'zhiyu-default-text': ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro'],
  'zhiyu-default-image': ['image-01'],
  'zhiyu-default-video': ['MiniMax-Hailuo-2.3'],
  'zhiyu-default-tts': ['speech-2.8-turbo', 'speech-2.8-hd'],
};

export function findPlatformDefaultDefinition(
  defaultId: string,
): PlatformDefaultDefinition | undefined {
  return PLATFORM_DEFAULT_DEFINITIONS.find((entry) => entry.defaultId === defaultId);
}

/** Map only explicitly supported legacy managed requests to a stable default. */
export function findLegacyPlatformDefault(
  capability: PlatformDefaultCapability,
  providerId: string,
  modelId?: string,
): PlatformDefaultDefinition | undefined {
  const definition = PLATFORM_DEFAULT_DEFINITIONS.find(
    (entry) => entry.capability === capability && entry.providerId === providerId,
  );
  if (!definition) return undefined;
  if (!modelId || LEGACY_PLATFORM_MODEL_ALIASES[definition.defaultId].includes(modelId)) {
    return definition;
  }
  return undefined;
}

export function isLegacyPlatformBacking(
  capability: PlatformDefaultCapability,
  providerId: string,
): boolean {
  return PLATFORM_DEFAULT_DEFINITIONS.some(
    (entry) => entry.capability === capability && entry.providerId === providerId,
  );
}

function parseEnabled(value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return !/^(false|0|no|off)$/i.test(value.trim());
}

function parseThinkingMode(value: string | undefined): ThinkingConfig['mode'] | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (['default', 'disabled', 'enabled', 'auto'].includes(normalized)) {
    return normalized as ThinkingConfig['mode'];
  }
  throw new Error('PLATFORM_DEFAULT_THINKING_MODE_INVALID');
}

function parseThinkingEffort(value: string | undefined): ThinkingConfig['effort'] | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(normalized)) {
    return normalized as ThinkingConfig['effort'];
  }
  throw new Error('PLATFORM_DEFAULT_THINKING_EFFORT_INVALID');
}

function thinkingCapability(
  parameters: PlatformDefaultParameters | undefined,
): ThinkingCapability | undefined {
  return parameters?.textThinking
    ? ({
        ...parameters.textThinking,
        effortValues: [...parameters.textThinking.effortValues],
      } as ThinkingCapability)
    : undefined;
}

export function hasExplicitPlatformThinkingIntent(config: ThinkingConfig | undefined): boolean {
  return Boolean(
    config &&
    ((config.mode !== undefined && config.mode !== 'default') ||
      config.effort !== undefined ||
      config.level !== undefined ||
      config.enabled !== undefined ||
      config.budgetTokens !== undefined ||
      config.excludeReasoningOutput !== undefined),
  );
}

export function isPlatformThinkingConfigSupported(
  parameters: PlatformDefaultParameters | undefined,
  config: ThinkingConfig,
): boolean {
  const mode = getThinkingMode(config);
  if (
    (mode === 'disabled' && config.effort !== undefined && config.effort !== 'none') ||
    (mode === 'enabled' && config.effort === 'none')
  ) {
    return false;
  }
  // Older/minimal platform bindings did not publish capabilities. Preserve an
  // already schema-validated preference; current bindings always define them.
  if (!parameters) return true;
  const thinking = parameters.textThinking;
  if (!thinking) return true;
  if (
    config.level !== undefined ||
    config.budgetTokens !== undefined ||
    config.excludeReasoningOutput !== undefined
  ) {
    return false;
  }
  return config.effort === undefined || thinking.effortValues.includes(config.effort as never);
}

export function normalizePlatformThinkingConfig(
  parameters: PlatformDefaultParameters | undefined,
  config: ThinkingConfig | undefined,
  defaultConfig?: ThinkingConfig,
): ThinkingConfig | undefined {
  const selected = hasExplicitPlatformThinkingIntent(config) ? config : defaultConfig;
  if (!parameters) return selected;
  if (!parameters.textThinking) return selected;
  if (selected && !isPlatformThinkingConfigSupported(parameters, selected)) return undefined;
  return normalizeThinkingConfig(thinkingCapability(parameters), selected);
}

export function resolvePlatformDefaultDefinition(
  definition: PlatformDefaultDefinition,
  yamlOverride?: PlatformDefaultOverride,
): PlatformDefaultDefinition & { enabled: boolean } {
  const modelId =
    process.env[`${definition.envPrefix}_MODEL`]?.trim() ||
    yamlOverride?.modelId?.trim() ||
    definition.modelId;
  const displayName =
    process.env[`${definition.envPrefix}_DISPLAY_NAME`]?.trim() ||
    yamlOverride?.displayName?.trim() ||
    definition.displayName;
  const envEnabled = parseEnabled(process.env[`${definition.envPrefix}_ENABLED`]);
  const envMode = parseThinkingMode(process.env[`${definition.envPrefix}_THINKING_MODE`]);
  const envEffort = parseThinkingEffort(process.env[`${definition.envPrefix}_THINKING_EFFORT`]);
  const configuredThinking = {
    ...(yamlOverride?.thinkingConfig ?? definition.defaultThinkingConfig),
    ...(envMode ? { mode: envMode } : {}),
    ...(envMode && !envEffort ? { effort: undefined } : {}),
    ...(envEffort ? { effort: envEffort } : {}),
  };
  const defaultThinkingConfig = normalizePlatformThinkingConfig(
    definition.parameters,
    configuredThinking,
  );
  if (Object.keys(configuredThinking).length > 0 && !defaultThinkingConfig) {
    throw new Error('PLATFORM_DEFAULT_THINKING_CONFIG_INVALID');
  }
  return {
    ...definition,
    modelId,
    displayName,
    enabled: envEnabled ?? yamlOverride?.enabled ?? true,
    ...(defaultThinkingConfig ? { defaultThinkingConfig } : {}),
  };
}

/**
 * Environment/YAML may toggle or relabel a released binding, but an unreviewed
 * model ID cannot inherit the capability/price policy verified for another
 * model. Upgrades add a new code definition and its parameters together.
 */
export function isVerifiedPlatformDefaultModel(resolved: PlatformDefaultDefinition): boolean {
  const released = findPlatformDefaultDefinition(resolved.defaultId);
  return Boolean(
    released &&
    released.providerId === resolved.providerId &&
    released.modelId === resolved.modelId,
  );
}

export function platformDefaultRevision(
  input: {
    defaultId: PlatformDefaultId;
    capability: PlatformDefaultCapability;
    providerId: string;
    modelId: string;
    parameters: PlatformDefaultParameters;
    defaultThinkingConfig?: ThinkingConfig;
    enabled: boolean;
    apiKey: string;
    baseUrl?: string;
    proxy?: string;
    /** Optional operator epoch in addition to automatic binding fingerprinting. */
    deploymentRevision: string;
  },
  revisionSecret: string,
): string {
  return createHmac('sha256', revisionSecret)
    .update(JSON.stringify(input))
    .digest('hex')
    .slice(0, 16);
}

export function toPublicPlatformDefault(
  definition: ReturnType<typeof resolvePlatformDefaultDefinition>,
  runtime: { configured: boolean; disabled: boolean; revision: string },
): PlatformDefaultCatalogEntry {
  const status =
    !definition.enabled || runtime.disabled
      ? 'disabled'
      : runtime.configured
        ? 'available'
        : 'not_configured';
  return {
    defaultId: definition.defaultId,
    capability: definition.capability,
    providerId: definition.providerId,
    providerName: definition.providerName,
    modelId: definition.modelId,
    displayName: definition.displayName,
    available: status === 'available',
    status,
    revision: runtime.revision,
    parameters: definition.parameters,
    ...(definition.defaultThinkingConfig
      ? { defaultThinkingConfig: definition.defaultThinkingConfig }
      : {}),
  };
}
