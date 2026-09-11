import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from 'typebox';

import { generateImage, IMAGE_PROVIDERS } from '@/lib/media/image-providers';
import type {
  ImageGenerationConfig,
  ImageGenerationOptions,
  ImageGenerationResult,
  ImageProviderId,
} from '@/lib/media/types';
import {
  enabledProviderIds,
  getServerImageProviders,
  isServerProviderDisabled,
  resolveImageApiKey,
  resolveImageBaseUrl,
  resolveImageModel,
} from '@/lib/server/provider-config';
import { createLogger } from '@/lib/logger';
import { resolveImageSize } from '@/lib/server/image-sizing';
import { recordGenerationUsage } from '@/lib/server/usage-storage';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import {
  DownloadByteBudget,
  MAX_REMOTE_IMAGE_BATCH_BYTES,
  MAX_REMOTE_IMAGE_BYTES,
  readResponseBodyWithLimit,
} from '@/lib/server/bounded-download';
import { CLASSROOMS_DIR } from '@/lib/server/classroom-storage';
import type { CourseToolDeps } from './course-tools';
import { COURSE_STAGE_ID_DESCRIPTION } from './course-stage';
import { errorResult, MEDIA_TOOL_ERROR_REASONS } from './media-tool-result';
import { withMediaProviderFetch } from '@/lib/server/media-provider-fetch';
import {
  platformImageExecutionOptions,
  resolveProviderSelection,
} from '@/lib/server/resolve-provider-selection';

const log = createLogger('AgentGenerateImage');

export const GENERATE_IMAGE_TOOL_NAME = 'generate_image';
export const GENERATE_IMAGE_TIMEOUT_MS = 300_000;

export const GenerateImageParams = Type.Object({
  stageId: Type.String({ description: COURSE_STAGE_ID_DESCRIPTION }),
  prompt: Type.String({
    minLength: 1,
    description: 'A concrete visual description of the image to create.',
  }),
  aspectRatio: Type.Optional(
    Type.Union([Type.Literal('16:9'), Type.Literal('1:1'), Type.Literal('4:3')], {
      description: 'Output aspect ratio. Defaults to 16:9.',
    }),
  ),
  styleHint: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        'Optional art-direction hint, such as watercolor, editorial photo or flat vector.',
    }),
  ),
});

type GenerateConfiguredImage = (
  config: ImageGenerationConfig,
  options: ImageGenerationOptions,
) => Promise<PersistableImageResult>;

type PersistableImageResult = ImageGenerationResult & {
  /** Inline bytes used by custom protocol adapters. */
  bytes?: Uint8Array;
  /** MIME supplied alongside inline bytes/base64. */
  mimeType?: string;
};

interface PersistImageInput {
  result: PersistableImageResult;
  stageId: string;
  signal: AbortSignal;
}

type PersistGeneratedImage = (input: PersistImageInput) => Promise<string>;

export interface GenerateImageToolDeps extends Pick<
  CourseToolDeps,
  'sessionId' | 'abortSignal' | 'mediaConfig'
> {
  getConfiguredProviders?: typeof getServerImageProviders;
  resolveProviderConfig?: (providerId: ImageProviderId) => ImageGenerationConfig;
  generateConfiguredImage?: GenerateConfiguredImage;
  persistGeneratedImage?: PersistGeneratedImage;
  timeoutMs?: number;
}

function extensionForMime(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  if (mime === 'image/png') return 'png';
  throw new Error(`Image provider returned unsupported content type: ${mime}`);
}

function normalizeImageMime(value: string | undefined): string {
  const mime = value?.split(';')[0]?.trim().toLowerCase() || 'image/png';
  if (!mime.startsWith('image/') || mime === 'image/svg+xml') {
    throw new Error(`Image provider returned unsupported content type: ${mime}`);
  }
  extensionForMime(mime);
  return mime;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('aborted');
}

function combineSignals(primary: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return primary ? AbortSignal.any([primary, timeout]) : timeout;
}

function isTimeout(signal: AbortSignal): boolean {
  return (
    signal.aborted && signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError'
  );
}

async function fetchGeneratedImage(url: string, signal: AbortSignal): Promise<Response> {
  const maxRedirects = 5;
  let currentUrl = url;
  for (let hop = 0; ; hop++) {
    throwIfAborted(signal);
    const ssrfError = await validateUrlForSSRF(currentUrl);
    throwIfAborted(signal);
    if (ssrfError) throw new Error(ssrfError);

    const response = await fetch(currentUrl, { redirect: 'manual', signal });
    if (response.status < 300 || response.status >= 400) return response;

    const location = response.headers.get('location');
    if (!location) throw new Error('Image download redirect has no Location header');
    if (hop >= maxRedirects) throw new Error('Image download exceeded 5 redirects');
    currentUrl = new URL(location, currentUrl).href;
  }
}

async function imageBytes(
  result: PersistableImageResult,
  signal: AbortSignal,
): Promise<{ bytes: Buffer; mime: string }> {
  if (result.bytes) {
    const bytes = Buffer.from(result.bytes);
    if (!bytes.length) throw new Error('Image provider returned empty image bytes');
    if (bytes.length > MAX_REMOTE_IMAGE_BYTES) {
      throw new Error(`Generated image exceeds the ${MAX_REMOTE_IMAGE_BYTES}-byte limit`);
    }
    return { bytes, mime: normalizeImageMime(result.mimeType) };
  }
  if (result.base64) {
    const bytes = Buffer.from(result.base64, 'base64');
    if (!bytes.length) throw new Error('Image provider returned empty base64 data');
    if (bytes.length > MAX_REMOTE_IMAGE_BYTES) {
      throw new Error(`Generated image exceeds the ${MAX_REMOTE_IMAGE_BYTES}-byte limit`);
    }
    return { bytes, mime: normalizeImageMime(result.mimeType) };
  }
  if (!result.url) throw new Error('Image provider returned neither URL nor image bytes');

  const response = await fetchGeneratedImage(result.url, signal);
  if (!response.ok) throw new Error(`Generated image download failed: HTTP ${response.status}`);
  const mime = response.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png';
  if (!mime.startsWith('image/')) {
    throw new Error(`Generated image download returned unexpected content type: ${mime}`);
  }
  const bytes = await readResponseBodyWithLimit(response, {
    maxBytes: MAX_REMOTE_IMAGE_BYTES,
    aggregateBudget: new DownloadByteBudget(MAX_REMOTE_IMAGE_BATCH_BYTES),
  });
  throwIfAborted(signal);
  return { bytes, mime };
}

/**
 * Persist through the same local classroom-media path used by classic mode,
 * returning an origin-independent RELATIVE serving path. The agent runtime has
 * no request to derive an origin from, and the durable value must stay valid
 * regardless of the origin the app is served from; the browser resolves the
 * relative path against the page origin. Classic request-bearing routes build
 * absolute URLs through `resolveMediaServingOrigin` instead.
 */
export async function defaultPersistGeneratedImage({
  result,
  stageId,
  signal,
}: PersistImageInput): Promise<string> {
  const { bytes, mime } = await imageBytes(result, signal);
  const hash = createHash('sha256').update(bytes).digest('hex');
  throwIfAborted(signal);

  const mediaDir = path.join(CLASSROOMS_DIR, stageId, 'media');
  const filename = `generated-${hash}.${extensionForMime(mime)}`;
  await fs.mkdir(mediaDir, { recursive: true });
  throwIfAborted(signal);
  await fs.writeFile(path.join(mediaDir, filename), bytes);
  throwIfAborted(signal);
  return `/api/classroom-media/${stageId}/media/${filename}`;
}

/**
 * Pick the image provider for this call: the operator's `DEFAULT_IMAGE_PROVIDER`
 * when it names an enabled provider, otherwise the first enabled provider.
 * Resolution goes through {@link enabledProviderIds}, so a force-disabled
 * provider is never selected and `DEFAULT_IMAGE_PROVIDER` cannot bypass the
 * force-off switch (#665).
 */
function selectProvider(
  configured: Record<string, { models?: string[]; disabled?: boolean }>,
): ImageProviderId | null {
  const ids = enabledProviderIds(configured);
  const requested = process.env.DEFAULT_IMAGE_PROVIDER?.trim();
  if (requested) return ids.includes(requested) ? (requested as ImageProviderId) : null;
  return (ids[0] as ImageProviderId | undefined) ?? null;
}

export function buildGenerateImageTool(
  deps: GenerateImageToolDeps,
): AgentTool<typeof GenerateImageParams, unknown> {
  const configuredProviders = deps.getConfiguredProviders ?? getServerImageProviders;
  const resolveProviderConfig =
    deps.resolveProviderConfig ??
    ((providerId: ImageProviderId): ImageGenerationConfig => ({
      providerId,
      apiKey: resolveImageApiKey(providerId),
      baseUrl: resolveImageBaseUrl(providerId),
      model: resolveImageModel(providerId),
    }));
  const callProvider = deps.generateConfiguredImage ?? generateImage;
  const persist = deps.persistGeneratedImage ?? defaultPersistGeneratedImage;

  const resolveSnapshotConfig = (): ImageGenerationConfig | undefined => {
    const selected = deps.mediaConfig?.image;
    if (!selected) return undefined;
    if (selected.source === 'platform') {
      const resolved = resolveProviderSelection({
        capability: 'image',
        source: selected.source,
        defaultId: selected.defaultId,
      });
      if (selected.revision !== resolved.revision) throw new Error('MEDIA_CONFIG_CHANGED');
      return {
        providerId: resolved.providerId as ImageProviderId,
        apiKey: resolved.apiKey,
        baseUrl: resolved.baseUrl,
        model: resolved.modelId,
      };
    }
    const resolved = resolveProviderSelection({
      capability: 'image',
      source: selected.source,
      providerId: selected.providerId,
      modelId: selected.modelId,
      apiKey: selected.apiKey,
      baseUrl: selected.baseUrl,
    });
    return {
      providerId: selected.providerId,
      apiKey: resolved.apiKey,
      baseUrl: resolved.baseUrl,
      model: resolved.modelId,
      ...(selected.protocol ? { protocol: selected.protocol } : {}),
      requiresApiKey: selected.requiresApiKey,
    } as ImageGenerationConfig;
  };

  return {
    name: GENERATE_IMAGE_TOOL_NAME,
    label: 'Generate image',
    description:
      'Create a new image from a prompt, persist it with the explicitly targeted course media, and return a renderable src plus dimensions. Use the returned src in a later patch_stage set of an existing media element, or add an image element with patch_stage. This tool never edits a page itself.',
    parameters: GenerateImageParams,
    async execute(toolCallId, params: Static<typeof GenerateImageParams>, signal) {
      const callerSignal = signal ?? deps.abortSignal;
      throwIfAborted(callerSignal);

      const prompt = params.prompt.trim();
      if (!prompt) return errorResult('Image generation failed: prompt must not be empty.');

      const stageId = params.stageId;
      throwIfAborted(callerSignal);

      if (deps.mediaConfig?.imageEnabled === false) {
        return errorResult('Image generation is unavailable.', {
          stageId,
          reason: MEDIA_TOOL_ERROR_REASONS.providerDisabled,
        });
      }

      const selected = deps.mediaConfig?.image;
      const selectedConfig = resolveSnapshotConfig();
      const providers = selected ? {} : configuredProviders();
      const providerId = selectedConfig?.providerId ?? selectProvider(providers);
      const requestedDefault = process.env.DEFAULT_IMAGE_PROVIDER?.trim();
      if (selected && selected.source !== 'platform' && !selected.enabled) {
        return errorResult('Image generation is unavailable.', {
          stageId,
          reason: MEDIA_TOOL_ERROR_REASONS.providerDisabled,
        });
      }
      if (!providerId) {
        if (requestedDefault) {
          log.warn(
            `[${toolCallId}] Image generation unavailable: requested default provider ${requestedDefault} is not enabled`,
          );
        } else {
          log.warn(
            `[${toolCallId}] Image generation unavailable: no enabled server image provider`,
          );
        }
        return errorResult(
          requestedDefault
            ? 'Image generation is unavailable: the server default image provider is not available.'
            : 'Image generation is unavailable: no server image provider is available.',
          {
            stageId,
            sessionId: deps.sessionId,
            reason: MEDIA_TOOL_ERROR_REASONS.noProvider,
          },
        );
      }

      // Defense in depth: the operator force-off is authoritative at the call
      // boundary — even if a caller explicitly selects a disabled provider id,
      // the call fails before any provider I/O (#665).
      if (isServerProviderDisabled('image', providerId)) {
        log.warn(
          `[${toolCallId}] Image generation rejected: provider ${providerId} is force-disabled`,
        );
        return errorResult('Image generation is unavailable.', {
          stageId,
          reason: MEDIA_TOOL_ERROR_REASONS.providerDisabled,
        });
      }

      const provider = IMAGE_PROVIDERS[providerId];
      const customProvider = String(providerId).startsWith('custom-image-');
      if (!provider && !customProvider) {
        log.error(
          `[${toolCallId}] Image generation unavailable: unsupported provider ${providerId}`,
        );
        return errorResult(
          'Image generation is unavailable: the selected provider is not supported by this server.',
          {
            stageId,
            reason: MEDIA_TOOL_ERROR_REASONS.unsupportedProvider,
          },
        );
      }
      const providerConfig = selectedConfig ?? resolveProviderConfig(providerId);
      if ((provider?.requiresApiKey ?? providerConfig.requiresApiKey) && !providerConfig.apiKey) {
        log.warn(
          `[${toolCallId}] Image generation unavailable: no API key configured for provider ${providerId}`,
        );
        return errorResult(
          'Image generation is unavailable: no API key is configured for the selected image provider.',
          { stageId, reason: MEDIA_TOOL_ERROR_REASONS.missingApiKey },
        );
      }

      const model = providerConfig.model;
      // The server-side model resolution is authoritative: the tool never
      // accepts a caller-supplied model, and a provider that expects one
      // fails loud here instead of silently falling back to an adapter
      // default. Model-less providers (empty catalog, e.g. workflow-driven
      // runners) resolve their own target at call time.
      if ((selected || (provider?.models?.length ?? 0) > 0) && !model) {
        log.warn(
          `[${toolCallId}] Image generation unavailable: no model configured for provider ${providerId}`,
        );
        return errorResult(
          'Image generation is unavailable: no model is configured for the selected image provider on this server.',
          {
            stageId,
            reason: MEDIA_TOOL_ERROR_REASONS.missingModel,
          },
        );
      }

      const options = resolveImageSize({
        prompt: params.styleHint
          ? `${prompt}\nStyle direction: ${params.styleHint.trim()}`
          : prompt,
        aspectRatio: params.aspectRatio ?? '16:9',
      });
      const ioSignal = combineSignals(callerSignal, deps.timeoutMs ?? GENERATE_IMAGE_TIMEOUT_MS);

      try {
        const platformOptions =
          selected?.source === 'platform'
            ? platformImageExecutionOptions(
                resolveProviderSelection({
                  capability: 'image',
                  source: selected.source,
                  defaultId: selected.defaultId,
                }),
              )
            : {};
        const providerOptions = {
          ...options,
          ...platformOptions,
          stageId,
          signal: ioSignal,
        };
        const result =
          (customProvider || providerId === 'comfyui-image' || providerId === 'lemonade') &&
          callProvider === generateImage
            ? await withMediaProviderFetch(providerConfig.baseUrl!, (fetcher) =>
                callProvider({ ...providerConfig, fetcher }, providerOptions),
              )
            : await callProvider(providerConfig, providerOptions);
        throwIfAborted(ioSignal);

        const src = await persist({ result, stageId, signal: ioSignal });
        throwIfAborted(ioSignal);
        void recordGenerationUsage({
          kind: 'image',
          unit: 'image',
          providerId,
          modelId: model,
          quantity: 1,
        });
        log.info(
          `[${toolCallId}] Image generated: provider=${providerId}, model=${model ?? 'default'}, ${result.width}x${result.height}`,
        );

        return {
          content: [
            {
              type: 'text',
              text: `Generated image: src=${src}, width=${result.width}, height=${result.height}. Use this src with patch_stage set or add an image element.`,
            },
          ],
          details: {
            src,
            width: result.width,
            height: result.height,
          },
        };
      } catch (error) {
        if (callerSignal?.aborted) throw new Error('aborted');
        if (isTimeout(ioSignal)) {
          log.warn(
            `[${toolCallId}] Image generation timed out: provider=${providerId}, model=${model ?? 'default'}, timeoutMs=${deps.timeoutMs ?? GENERATE_IMAGE_TIMEOUT_MS}`,
          );
          return errorResult('Image generation timed out after the configured server timeout.', {
            stageId,
            reason: MEDIA_TOOL_ERROR_REASONS.timeout,
          });
        }
        const message = error instanceof Error ? error.message : String(error);
        log.error(
          `[${toolCallId}] Image generation failed: provider=${providerId}, model=${model ?? 'default'}, error=${message}`,
          error,
        );
        return errorResult('Image generation failed.', {
          stageId,
          reason: MEDIA_TOOL_ERROR_REASONS.generationFailed,
        });
      }
    },
  };
}
