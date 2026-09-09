import { z } from 'zod';
import type { ApiErrorCode } from '@/lib/server/api-response';
import type {
  ImageGenerationConfig,
  ImageProviderId,
  VideoGenerationConfig,
  VideoProviderId,
} from '@/lib/media/types';
import type {
  ASRModelConfig,
  ASRProviderId,
  TTSModelConfig,
  TTSProviderId,
} from '@/lib/audio/types';

export const CUSTOM_SPEECH_PROTOCOL = 'openai-speech' as const;
export const CUSTOM_TRANSCRIPTION_PROTOCOL = 'openai-transcription' as const;

export class MediaProviderConfigError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly status = 400,
  ) {
    super(code);
    this.name = 'MediaProviderConfigError';
  }
}

const secret = z.string().max(16_384).optional().default('');
const baseUrl = z.string().trim().min(1).max(2_048);
const modelId = z.string().trim().min(1).max(500);

const customImageSchema = z
  .object({
    id: z.string().startsWith('custom-image-').optional(),
    apiKey: secret,
    baseUrl,
    enabled: z.boolean().optional().default(true),
    protocol: z.enum(['openai-images', 'siliconflow-images', 'openrouter-images']),
    requiresApiKey: z.boolean().optional().default(true),
    modelId: modelId.optional(),
    model: modelId.optional(),
  })
  .strict();

const customVideoSchema = z
  .object({
    id: z.string().startsWith('custom-video-').optional(),
    apiKey: secret,
    baseUrl,
    enabled: z.boolean().optional().default(true),
    protocol: z.enum(['siliconflow-video', 'openrouter-video']),
    requiresApiKey: z.boolean().optional().default(true),
    modelId: modelId.optional(),
    model: modelId.optional(),
  })
  .strict();

const customTTSSchema = z
  .object({
    id: z.string().startsWith('custom-tts-').optional(),
    apiKey: secret,
    baseUrl,
    enabled: z.boolean().optional().default(true),
    protocol: z.literal(CUSTOM_SPEECH_PROTOCOL),
    requiresApiKey: z.boolean().optional().default(true),
    modelId,
    voice: z.string().trim().min(1).max(500),
    speed: z.number().min(0.25).max(4).optional(),
    format: z.string().trim().min(1).max(32).optional(),
    providerOptions: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const customASRSchema = z
  .object({
    id: z.string().startsWith('custom-asr-').optional(),
    apiKey: secret,
    baseUrl,
    enabled: z.boolean().optional().default(true),
    protocol: z.literal(CUSTOM_TRANSCRIPTION_PROTOCOL),
    requiresApiKey: z.boolean().optional().default(true),
    modelId,
    language: z.string().trim().max(100).optional(),
  })
  .strict();

function assertCustomId(expected: string, supplied?: string): void {
  if (supplied && supplied !== expected) {
    throw new MediaProviderConfigError('PROVIDER_CONFIG_ID_MISMATCH');
  }
}

function assertEnabled(enabled: boolean): void {
  if (!enabled) throw new MediaProviderConfigError('PROVIDER_DISABLED', 403);
}

function assertCredential(requiresApiKey: boolean, apiKey: string): void {
  if (requiresApiKey && !apiKey.trim()) {
    throw new MediaProviderConfigError('MISSING_API_KEY', 401);
  }
}

/**
 * Normalize a user-supplied API root without guessing or replacing its path.
 * Authentication material in a URL is rejected so it cannot leak through logs,
 * redirects, or ordinary request metadata.
 */
export function normalizeMediaProviderBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MediaProviderConfigError('INVALID_BASE_URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new MediaProviderConfigError('INVALID_BASE_URL');
  }
  if (url.username || url.password || url.hash || url.search) {
    throw new MediaProviderConfigError('UNSAFE_BASE_URL');
  }
  return url.toString().replace(/\/$/, '');
}

export function parseCustomImageProviderConfig(
  providerId: ImageProviderId,
  input: unknown,
  selectedModel?: string,
): ImageGenerationConfig {
  if (!String(providerId).startsWith('custom-image-')) {
    throw new MediaProviderConfigError('INVALID_CUSTOM_IMAGE_PROVIDER');
  }
  const parsed = customImageSchema.safeParse(input);
  if (!parsed.success) throw new MediaProviderConfigError('INVALID_PROVIDER_CONFIG');
  assertCustomId(providerId, parsed.data.id);
  assertEnabled(parsed.data.enabled);
  assertCredential(parsed.data.requiresApiKey, parsed.data.apiKey);
  const model = selectedModel?.trim() || parsed.data.modelId || parsed.data.model;
  if (!model) throw new MediaProviderConfigError('MISSING_MODEL');
  return {
    providerId,
    apiKey: parsed.data.apiKey,
    baseUrl: normalizeMediaProviderBaseUrl(parsed.data.baseUrl),
    model,
    protocol: parsed.data.protocol,
    requiresApiKey: parsed.data.requiresApiKey,
  };
}

export function parseCustomVideoProviderConfig(
  providerId: VideoProviderId,
  input: unknown,
  selectedModel?: string,
): VideoGenerationConfig {
  if (!String(providerId).startsWith('custom-video-')) {
    throw new MediaProviderConfigError('INVALID_CUSTOM_VIDEO_PROVIDER');
  }
  const parsed = customVideoSchema.safeParse(input);
  if (!parsed.success) throw new MediaProviderConfigError('INVALID_PROVIDER_CONFIG');
  assertCustomId(providerId, parsed.data.id);
  assertEnabled(parsed.data.enabled);
  assertCredential(parsed.data.requiresApiKey, parsed.data.apiKey);
  const model = selectedModel?.trim() || parsed.data.modelId || parsed.data.model;
  if (!model) throw new MediaProviderConfigError('MISSING_MODEL');
  return {
    providerId,
    apiKey: parsed.data.apiKey,
    baseUrl: normalizeMediaProviderBaseUrl(parsed.data.baseUrl),
    model,
    protocol: parsed.data.protocol,
    requiresApiKey: parsed.data.requiresApiKey,
  };
}

export function parseCustomTTSProviderConfig(
  providerId: TTSProviderId,
  input: unknown,
): TTSModelConfig {
  if (!String(providerId).startsWith('custom-tts-')) {
    throw new MediaProviderConfigError('INVALID_CUSTOM_TTS_PROVIDER');
  }
  const parsed = customTTSSchema.safeParse(input);
  if (!parsed.success) throw new MediaProviderConfigError('INVALID_PROVIDER_CONFIG');
  assertCustomId(providerId, parsed.data.id);
  assertEnabled(parsed.data.enabled);
  assertCredential(parsed.data.requiresApiKey, parsed.data.apiKey);
  return {
    providerId,
    apiKey: parsed.data.apiKey,
    baseUrl: normalizeMediaProviderBaseUrl(parsed.data.baseUrl),
    modelId: parsed.data.modelId,
    voice: parsed.data.voice,
    speed: parsed.data.speed,
    format: parsed.data.format,
    providerOptions: parsed.data.providerOptions,
  };
}

export function parseCustomASRProviderConfig(
  providerId: ASRProviderId,
  input: unknown,
): ASRModelConfig {
  if (!String(providerId).startsWith('custom-asr-')) {
    throw new MediaProviderConfigError('INVALID_CUSTOM_ASR_PROVIDER');
  }
  const parsed = customASRSchema.safeParse(input);
  if (!parsed.success) throw new MediaProviderConfigError('INVALID_PROVIDER_CONFIG');
  assertCustomId(providerId, parsed.data.id);
  assertEnabled(parsed.data.enabled);
  assertCredential(parsed.data.requiresApiKey, parsed.data.apiKey);
  return {
    providerId,
    apiKey: parsed.data.apiKey,
    baseUrl: normalizeMediaProviderBaseUrl(parsed.data.baseUrl),
    modelId: parsed.data.modelId,
    language: parsed.data.language,
  };
}
