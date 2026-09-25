/**
 * Server-side media and TTS generation for classrooms.
 *
 * Generates image/video files and TTS audio for a classroom, persists them
 * through the deployment's classroom-media backend, and returns serving URL
 * mappings.
 */

import path from 'path';
import { createLogger } from '@/lib/logger';
import { persistClassroomMediaBytes } from '@/lib/server/classroom-media-bytes';
import { generateImage } from '@/lib/media/image-providers';
import { generateVideo, normalizeVideoOptions } from '@/lib/media/video-providers';
import { generateTTS } from '@/lib/audio/tts-providers';
import { DEFAULT_TTS_VOICES, DEFAULT_TTS_MODELS, TTS_PROVIDERS } from '@/lib/audio/constants';
import { IMAGE_PROVIDERS } from '@/lib/media/image-providers';
import { VIDEO_PROVIDERS } from '@/lib/media/video-providers';
import {
  getServerImageProviders,
  getServerVideoProviders,
  getServerTTSProviders,
} from '@/lib/server/provider-config';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene } from '@/lib/types/stage';
import type { SpeechAction } from '@/lib/types/action';
import type { ImageProviderId } from '@/lib/media/types';
import type { VideoProviderId } from '@/lib/media/types';
import type { TTSProviderId } from '@/lib/audio/types';
import { splitLongSpeechActions } from '@/lib/audio/tts-utils';
import { isGeneratedMediaPlaceholder } from '@/lib/media/media-ref';
import { VOXCPM_AUTO_VOICE_ID, VOXCPM_TTS_PROVIDER_ID } from '@/lib/audio/voxcpm';
import {
  platformImageExecutionOptions,
  platformVideoExecutionOptions,
  resolveProviderSelection,
  type ResolvedProviderSelection,
} from '@/lib/server/resolve-provider-selection';
import type { MediaConfigSnapshotContent } from '@/lib/server/media-config-snapshots';
import {
  mediaConfigVoiceSource,
  resolveEffectiveSessionVoice,
} from '@/lib/server/agent-runtime/effective-voice-directory';

const log = createLogger('ClassroomMedia');

export interface ClassroomMediaSelection {
  source?: 'platform' | 'user' | 'legacy-managed';
  defaultId?: string;
  revision?: string;
  providerId?: string;
  modelId?: string;
  apiKey?: string;
  baseUrl?: string;
  voiceId?: string;
}

export interface ClassroomMediaSelections {
  image?: ClassroomMediaSelection;
  video?: ClassroomMediaSelection;
  tts?: ClassroomMediaSelection;
}

function snapshotSelection(config?: {
  source?: 'platform' | 'user' | 'legacy-managed';
  defaultId?: string;
  revision?: string;
  providerId?: string;
  modelId?: string;
  apiKey?: string;
  baseUrl?: string;
  voice?: string;
}): ClassroomMediaSelection | undefined {
  if (!config) return undefined;
  if (config.source === 'platform' && config.defaultId) {
    return {
      source: config.source,
      defaultId: config.defaultId,
      ...(config.revision ? { revision: config.revision } : {}),
      ...(config.voice ? { voiceId: config.voice } : {}),
    };
  }
  if (!config.providerId) return undefined;
  return {
    source:
      config.source ??
      (config.apiKey?.trim() || config.baseUrl?.trim() ? 'user' : 'legacy-managed'),
    providerId: config.providerId,
    modelId: config.modelId,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    ...(config.voice ? { voiceId: config.voice } : {}),
  };
}

/** Translate one already owner-loaded encrypted snapshot into old classroom execution intent. */
export function classroomMediaSelectionsFromSnapshot(
  snapshot: MediaConfigSnapshotContent,
): ClassroomMediaSelections {
  const voice =
    snapshot.ttsEnabled === false
      ? undefined
      : resolveEffectiveSessionVoice(mediaConfigVoiceSource(snapshot));
  return {
    ...(snapshot.imageEnabled === false ? {} : { image: snapshotSelection(snapshot.image) }),
    ...(snapshot.videoEnabled === false ? {} : { video: snapshotSelection(snapshot.video) }),
    ...(voice ? { tts: snapshotSelection(voice) } : {}),
  };
}

/**
 * The classroom JSON payload is a pre-conversion transport, not a persisted
 * DSL document. `audioUrl` is gone from the `SpeechAction` contract, but the
 * file-based classroom store has no asset registry to allocate from, so the
 * server still hands the client the serving URL beside the derived `audioId`.
 * The app-side reference converter ingests the URL's bytes and rewrites the
 * pair to one allocated asset id when the classroom is first fetched, before
 * the document is persisted client-side; the URL never enters a stored
 * document.
 */
type ServerTransportSpeechAction = SpeechAction & { audioUrl?: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DOWNLOAD_TIMEOUT_MS = 120_000; // 2 minutes
const DOWNLOAD_MAX_SIZE = 100 * 1024 * 1024; // 100 MB

async function downloadToBuffer(url: string): Promise<Buffer> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`Download failed: ${resp.status} ${resp.statusText}`);
  const contentLength = Number(resp.headers.get('content-length') || 0);
  if (contentLength > DOWNLOAD_MAX_SIZE) {
    throw new Error(`File too large: ${contentLength} bytes (max ${DOWNLOAD_MAX_SIZE})`);
  }
  return Buffer.from(await resp.arrayBuffer());
}

function mediaServingUrl(baseUrl: string, classroomId: string, subPath: string): string {
  return `${baseUrl}/api/classroom-media/${classroomId}/${subPath}`;
}

// ---------------------------------------------------------------------------
// Image / Video generation
// ---------------------------------------------------------------------------

export async function generateMediaForClassroom(
  outlines: SceneOutline[],
  classroomId: string,
  baseUrl: string,
  selections: ClassroomMediaSelections = {},
): Promise<Record<string, string>> {
  // Collect all media generation requests from outlines
  const requests = outlines.flatMap((o) => o.mediaGenerations ?? []);
  if (requests.length === 0) return {};

  // Resolve providers, excluding operator force-disabled ones (server
  // precedence, #665 — mirror the TTS listing's disabled flag).
  const imageProviderIds = Object.entries(getServerImageProviders())
    .filter(([, info]) => !info.disabled)
    .map(([id]) => id);
  const videoProviderIds = Object.entries(getServerVideoProviders())
    .filter(([, info]) => !info.disabled)
    .map(([id]) => id);

  const resolveSelection = (
    capability: 'image' | 'video',
    selection: ClassroomMediaSelection | undefined,
    fallbackProviderId: string | undefined,
  ): ResolvedProviderSelection | undefined => {
    if (!selection && !fallbackProviderId) return undefined;
    const providerId = selection?.providerId ?? fallbackProviderId;
    const catalogModel =
      capability === 'image'
        ? IMAGE_PROVIDERS[providerId as keyof typeof IMAGE_PROVIDERS]?.models?.[0]?.id
        : VIDEO_PROVIDERS[providerId as keyof typeof VIDEO_PROVIDERS]?.models?.[0]?.id;
    const resolved = resolveProviderSelection({
      capability,
      source: selection?.source,
      defaultId: selection?.defaultId,
      providerId,
      modelId: selection?.modelId ?? catalogModel,
      apiKey: selection?.apiKey,
      baseUrl: selection?.baseUrl,
    });
    if (selection?.revision && selection.revision !== resolved.revision) {
      throw new Error('MEDIA_CONFIG_CHANGED');
    }
    return resolved;
  };
  const imageSelection = resolveSelection('image', selections.image, imageProviderIds[0]);
  const videoSelection = resolveSelection('video', selections.video, videoProviderIds[0]);
  const mediaMap: Record<string, string> = {};

  // Separate image and video requests, generate each type sequentially
  // but run the two types in parallel (providers often have limited concurrency).
  const imageRequests = requests.filter((r) => r.type === 'image' && !!imageSelection);
  const videoRequests = requests.filter((r) => r.type === 'video' && !!videoSelection);

  const generateImages = async () => {
    for (const req of imageRequests) {
      try {
        const providerId = imageSelection!.providerId as ImageProviderId;
        const apiKey = imageSelection!.apiKey;
        const providerConfig = IMAGE_PROVIDERS[providerId];
        if (providerConfig?.requiresApiKey && !apiKey) {
          log.warn(`No API key for image provider "${providerId}", skipping ${req.elementId}`);
          continue;
        }
        // Selection resolution above is the sole source of provider, model,
        // endpoint and credentials for this outbound request.
        const model = imageSelection!.modelId;

        const result = await generateImage(
          { providerId, apiKey, baseUrl: imageSelection!.baseUrl, model },
          {
            prompt: req.prompt,
            aspectRatio: req.aspectRatio || '16:9',
            ...(imageSelection!.source === 'platform'
              ? platformImageExecutionOptions(imageSelection!)
              : {}),
          },
        );

        let buf: Buffer;
        let ext: string;
        if (result.base64) {
          buf = Buffer.from(result.base64, 'base64');
          ext = 'png';
        } else if (result.url) {
          buf = await downloadToBuffer(result.url);
          const urlExt = path.extname(new URL(result.url).pathname).replace('.', '');
          ext = ['png', 'jpg', 'jpeg', 'webp'].includes(urlExt) ? urlExt : 'png';
        } else {
          log.warn(`Image generation returned no data for ${req.elementId}`);
          continue;
        }

        const filename = `${req.elementId}.${ext}`;
        const mime =
          ext === 'jpg' || ext === 'jpeg'
            ? 'image/jpeg'
            : ext === 'webp'
              ? 'image/webp'
              : 'image/png';
        await persistClassroomMediaBytes({
          stageId: classroomId,
          bytes: buf,
          mime,
          filename,
        });
        mediaMap[req.elementId] = mediaServingUrl(baseUrl, classroomId, `media/${filename}`);
        log.info(`Generated image: ${filename}`);
      } catch (err) {
        log.warn(`Image generation failed for ${req.elementId}:`, err);
      }
    }
  };

  const generateVideos = async () => {
    for (const req of videoRequests) {
      try {
        const providerId = videoSelection!.providerId as VideoProviderId;
        const apiKey = videoSelection!.apiKey;
        if (!apiKey) {
          log.warn(`No API key for video provider "${providerId}", skipping ${req.elementId}`);
          continue;
        }
        // Selection resolution above is the sole source of provider, model,
        // endpoint and credentials for this outbound request.
        const model = videoSelection!.modelId;

        const normalized = normalizeVideoOptions(providerId, {
          prompt: req.prompt,
          aspectRatio: (req.aspectRatio as '16:9' | '4:3' | '1:1' | '9:16') || '16:9',
          ...(videoSelection!.source === 'platform'
            ? platformVideoExecutionOptions(videoSelection!)
            : {}),
        });

        const result = await generateVideo(
          { providerId, apiKey, baseUrl: videoSelection!.baseUrl, model },
          normalized,
        );

        const buf = result.bytes?.length
          ? Buffer.from(result.bytes)
          : result.base64
            ? Buffer.from(result.base64, 'base64')
            : result.url
              ? await downloadToBuffer(result.url)
              : null;
        if (!buf?.length) throw new Error('Video generation returned no data');
        const filename = `${req.elementId}.mp4`;
        await persistClassroomMediaBytes({
          stageId: classroomId,
          bytes: buf,
          mime: 'video/mp4',
          filename,
        });
        mediaMap[req.elementId] = mediaServingUrl(baseUrl, classroomId, `media/${filename}`);
        log.info(`Generated video: ${filename}`);
      } catch (err) {
        log.warn(`Video generation failed for ${req.elementId}:`, err);
      }
    }
  };

  await Promise.all([generateImages(), generateVideos()]);

  return mediaMap;
}

// ---------------------------------------------------------------------------
// Placeholder replacement in scene content
// ---------------------------------------------------------------------------

export function replaceMediaPlaceholders(scenes: Scene[], mediaMap: Record<string, string>): void {
  if (Object.keys(mediaMap).length === 0) return;

  for (const scene of scenes) {
    if (scene.type !== 'slide') continue;
    const canvas = (
      scene.content as {
        canvas?: {
          elements?: Array<{ id: string; src?: string; mediaRef?: string; type?: string }>;
        };
      }
    )?.canvas;
    if (!canvas?.elements) continue;

    for (const el of canvas.elements) {
      if (
        el.type === 'video' &&
        typeof el.mediaRef === 'string' &&
        mediaMap[el.mediaRef] &&
        (!el.src || /^gen_vid_[\w-]+$/i.test(el.src))
      ) {
        el.src = mediaMap[el.mediaRef];
        continue;
      }
      if (
        (el.type === 'image' || el.type === 'video') &&
        typeof el.src === 'string' &&
        isGeneratedMediaPlaceholder(el.src) &&
        mediaMap[el.src]
      ) {
        el.src = mediaMap[el.src];
      }
    }
  }
}

// ---------------------------------------------------------------------------
// TTS generation
// ---------------------------------------------------------------------------

export async function generateTTSForClassroom(
  scenes: Scene[],
  classroomId: string,
  baseUrl: string,
  selection?: ClassroomMediaSelection,
): Promise<void> {
  // Resolve TTS provider (exclude browser-native-tts and operator force-disabled
  // providers — server precedence, #665).
  const ttsProviderIds = Object.entries(getServerTTSProviders())
    .filter(([id, info]) => id !== 'browser-native-tts' && !info.disabled)
    .map(([id]) => id);
  if (!selection && ttsProviderIds.length === 0) {
    log.warn('No server TTS provider configured, skipping TTS generation');
    return;
  }

  const fallbackProviderId = ttsProviderIds[0] as TTSProviderId | undefined;
  const requestedProviderId = selection?.providerId ?? fallbackProviderId;
  const resolved = resolveProviderSelection({
    capability: 'tts',
    source: selection?.source,
    defaultId: selection?.defaultId,
    providerId: requestedProviderId,
    modelId:
      selection?.modelId ??
      DEFAULT_TTS_MODELS[requestedProviderId as keyof typeof DEFAULT_TTS_MODELS],
    apiKey: selection?.apiKey,
    baseUrl: selection?.baseUrl,
    voiceId: selection?.voiceId,
  });
  if (selection?.revision && selection.revision !== resolved.revision) {
    throw new Error('MEDIA_CONFIG_CHANGED');
  }
  const providerId = resolved.providerId as TTSProviderId;
  const apiKey = resolved.apiKey;
  const ttsProvider = TTS_PROVIDERS[providerId as keyof typeof TTS_PROVIDERS];
  if (ttsProvider?.requiresApiKey && !apiKey) {
    log.warn(`No API key for TTS provider "${providerId}", skipping TTS generation`);
    return;
  }
  const ttsBaseUrl = resolved.baseUrl || ttsProvider?.defaultBaseUrl;
  const voice =
    (resolved.source === 'platform' ? resolved.platformParameters?.ttsVoice : selection?.voiceId) ||
    DEFAULT_TTS_VOICES[providerId as keyof typeof DEFAULT_TTS_VOICES] ||
    'default';
  const format = ttsProvider?.supportedFormats?.[0] || 'mp3';
  if (providerId === VOXCPM_TTS_PROVIDER_ID && voice === VOXCPM_AUTO_VOICE_ID) {
    log.warn('VoxCPM Auto Voice requires agent context; skipping server-side TTS generation');
    return;
  }

  for (const scene of scenes) {
    if (!scene.actions) continue;

    // Split long speech actions into multiple shorter ones before TTS generation,
    // mirroring the client-side approach. Each sub-action gets its own audio file.
    scene.actions = splitLongSpeechActions(scene.actions, providerId);

    // Use scene order to make audio IDs unique across scenes
    const sceneOrder = scene.order;

    for (const action of scene.actions) {
      if (action.type !== 'speech' || !(action as SpeechAction).text) continue;
      const speechAction = action as ServerTransportSpeechAction;
      // Server transport emits the derived id plus the serving URL; the
      // client-side converter collapses the pair into one pool asset on
      // first load. Browser generation allocates pool ids directly.
      const audioId = `tts_s${sceneOrder}_${action.id}`;

      try {
        const result = await generateTTS(
          {
            providerId,
            modelId:
              resolved.modelId ||
              DEFAULT_TTS_MODELS[providerId as keyof typeof DEFAULT_TTS_MODELS] ||
              '',
            apiKey,
            baseUrl: ttsBaseUrl,
            voice,
            speed: speechAction.speed,
          },
          speechAction.text,
        );

        const filename = `${audioId}.${result.format || format}`;
        const audioFormat = result.format || format;
        const mime =
          audioFormat === 'wav' ? 'audio/wav' : audioFormat === 'ogg' ? 'audio/ogg' : 'audio/mpeg';
        await persistClassroomMediaBytes({
          stageId: classroomId,
          bytes: result.audio,
          mime,
          filename,
          subdir: 'audio',
        });

        speechAction.audioId = audioId;
        speechAction.audioUrl = mediaServingUrl(baseUrl, classroomId, `audio/${filename}`);
        log.info(`Generated TTS: ${filename} (${result.audio.length} bytes)`);
      } catch (err) {
        log.warn(`TTS generation failed for action ${action.id}:`, err);
      }
    }
  }
}
