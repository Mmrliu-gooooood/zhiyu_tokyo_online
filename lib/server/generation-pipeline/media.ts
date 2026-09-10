import { fetch as undiciFetch } from 'undici';
import type { AgentInfo } from '@openmaic/generation';
import { generateImage, IMAGE_PROVIDERS } from '@/lib/media/image-providers';
import { generateVideo, normalizeVideoOptions, VIDEO_PROVIDERS } from '@/lib/media/video-providers';
import { generateTTS } from '@/lib/audio/tts-providers';
import { DEFAULT_TTS_MODELS, DEFAULT_TTS_VOICES, TTS_PROVIDERS } from '@/lib/audio/constants';
import { splitLongSpeechActions } from '@/lib/audio/tts-utils';
import { buildAutoVoxCPMVoicePrompt, VOXCPM_AUTO_VOICE_ID } from '@/lib/audio/voxcpm';
import {
  getServerImageProviders,
  getServerVideoProviders,
  getServerTTSProviders,
  resolveImageApiKey,
  resolveImageBaseUrl,
  resolveImageModel,
  resolveVideoApiKey,
  resolveVideoBaseUrl,
  resolveVideoModel,
  resolveTTSApiKey,
  resolveTTSBaseUrl,
} from '@/lib/server/provider-config';
import { createPinnedFetchAgent } from '@/lib/server/pinned-fetch-agent';
import { normalizeUrlForStrictFetch } from '@/lib/server/ssrf-guard';
import { readResponseBodyWithLimit } from '@/lib/server/bounded-download';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene } from '@/lib/types/stage';
import type { ImageProviderId, VideoProviderId } from '@/lib/media/types';
import type { TTSProviderId } from '@/lib/audio/types';
import type { GenerationInput } from '@/lib/server/generation-jobs/contracts';
import type { MediaConfigSnapshotContent } from '@/lib/server/media-config-snapshots';
import {
  parseCustomImageProviderConfig,
  parseCustomTTSProviderConfig,
  parseCustomVideoProviderConfig,
} from '@/lib/server/media-provider-config';
import { isServerProviderDisabled } from '@/lib/server/provider-config';
import { withMediaProviderFetch } from '@/lib/server/media-provider-fetch';
import type { PipelineAssets } from './services';
import { PipelineExecution, mapBounded } from './execution';
import {
  mediaConfigVoiceSource,
  resolveEffectiveSessionVoice,
} from '@/lib/server/agent-runtime/effective-voice-directory';

async function download(url: string, signal: AbortSignal, maxBytes: number): Promise<Buffer> {
  const dispatcher = createPinnedFetchAgent();
  try {
    const target = normalizeUrlForStrictFetch(url);
    const response = await undiciFetch(target, {
      dispatcher,
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
    });
    if (!response.ok) throw new Error('MEDIA_DOWNLOAD_FAILED');
    return await readResponseBodyWithLimit(response as unknown as Response, { maxBytes });
  } finally {
    await dispatcher.close();
  }
}

function customSnapshotInput<T extends { providerId: string }>(config: T | undefined): unknown {
  if (!config) return undefined;
  const { providerId, ...rest } = config;
  return { ...rest, id: providerId };
}

export class GenerationMediaServices {
  constructor(
    readonly execution: PipelineExecution,
    readonly input: GenerationInput,
    readonly assets: PipelineAssets,
    readonly mediaConfig?: MediaConfigSnapshotContent,
  ) {}

  async media(original: Scene, outline: SceneOutline): Promise<Scene> {
    const scene = structuredClone(original);
    const mapping: Record<string, string> = {};
    for (const request of outline.mediaGenerations ?? []) {
      if (
        (request.type === 'image' && !this.input.enableImageGeneration) ||
        (request.type === 'video' && !this.input.enableVideoGeneration)
      )
        continue;
      const key = `media:${outline.id}:${request.elementId}`;
      if (request.type === 'image') {
        if (this.mediaConfig?.imageEnabled === false)
          throw new Error('IMAGE_PROVIDER_NOT_CONFIGURED');
        const providerId = (this.input.media?.image?.providerId ??
          Object.entries(getServerImageProviders()).find(([, info]) => !info.disabled)?.[0]) as
          | ImageProviderId
          | undefined;
        if (!providerId || isServerProviderDisabled('image', providerId))
          throw new Error('IMAGE_PROVIDER_NOT_CONFIGURED');
        const snapshot = this.mediaConfig?.image;
        const selectedSnapshot = snapshot?.providerId === providerId ? snapshot : undefined;
        if (
          this.mediaConfig?.imageEnabled === true &&
          (!selectedSnapshot || !selectedSnapshot.enabled)
        )
          throw new Error('IMAGE_PROVIDER_NOT_CONFIGURED');
        const custom = providerId.startsWith('custom-image-');
        const provider = custom
          ? undefined
          : IMAGE_PROVIDERS[providerId as keyof typeof IMAGE_PROVIDERS];
        const providerConfig = custom
          ? parseCustomImageProviderConfig(
              providerId as Parameters<typeof parseCustomImageProviderConfig>[0],
              customSnapshotInput(snapshot?.providerId === providerId ? snapshot : undefined),
              this.input.media?.image?.modelId,
            )
          : {
              providerId: providerId as keyof typeof IMAGE_PROVIDERS,
              apiKey: resolveImageApiKey(providerId, selectedSnapshot?.apiKey),
              baseUrl: resolveImageBaseUrl(providerId, selectedSnapshot?.baseUrl),
              model:
                resolveImageModel(
                  providerId,
                  selectedSnapshot?.modelId || this.input.media?.image?.modelId,
                ) ?? provider?.models[0]?.id,
            };
        if (provider?.requiresApiKey && !providerConfig.apiKey)
          throw new Error('IMAGE_PROVIDER_NOT_CONFIGURED');
        const result = await this.execution.external(
          key,
          request,
          'media',
          providerId,
          async (signal) => {
            const options = {
              prompt: request.prompt,
              aspectRatio: request.aspectRatio ?? '16:9',
              signal,
            };
            const restrictedEndpoint =
              custom || providerId === 'comfyui-image' || providerId === 'lemonade';
            const output = restrictedEndpoint
              ? await withMediaProviderFetch(providerConfig.baseUrl!, (fetcher) =>
                  generateImage({ ...providerConfig, fetcher }, options),
                )
              : await generateImage(providerConfig, options);
            signal.throwIfAborted();
            const bytes = output.bytes?.length
              ? Buffer.from(output.bytes)
              : output.base64
                ? Buffer.from(output.base64, 'base64')
                : output.url
                  ? await download(output.url, signal, 20 * 1024 * 1024)
                  : null;
            if (!bytes?.length || bytes.length > 20 * 1024 * 1024)
              throw new Error('INVALID_IMAGE_OUTPUT');
            signal.throwIfAborted();
            return this.assets.write(
              `scene:${outline.id}:${key}`,
              bytes,
              output.mimeType || 'image/png',
            );
          },
          true,
        );
        if (result) mapping[request.elementId] = result;
      } else {
        if (this.mediaConfig?.videoEnabled === false)
          throw new Error('VIDEO_PROVIDER_NOT_CONFIGURED');
        const providerId = (this.input.media?.video?.providerId ??
          Object.entries(getServerVideoProviders()).find(([, info]) => !info.disabled)?.[0]) as
          | VideoProviderId
          | undefined;
        if (!providerId || isServerProviderDisabled('video', providerId))
          throw new Error('VIDEO_PROVIDER_NOT_CONFIGURED');
        const snapshot = this.mediaConfig?.video;
        const selectedSnapshot = snapshot?.providerId === providerId ? snapshot : undefined;
        if (
          this.mediaConfig?.videoEnabled === true &&
          (!selectedSnapshot || !selectedSnapshot.enabled)
        )
          throw new Error('VIDEO_PROVIDER_NOT_CONFIGURED');
        const custom = providerId.startsWith('custom-video-');
        const providerConfig = custom
          ? parseCustomVideoProviderConfig(
              providerId as Parameters<typeof parseCustomVideoProviderConfig>[0],
              customSnapshotInput(snapshot?.providerId === providerId ? snapshot : undefined),
              this.input.media?.video?.modelId,
            )
          : {
              providerId: providerId as keyof typeof VIDEO_PROVIDERS,
              apiKey: resolveVideoApiKey(providerId, selectedSnapshot?.apiKey),
              baseUrl: resolveVideoBaseUrl(providerId, selectedSnapshot?.baseUrl),
              model:
                resolveVideoModel(
                  providerId,
                  selectedSnapshot?.modelId || this.input.media?.video?.modelId,
                ) ?? VIDEO_PROVIDERS[providerId as keyof typeof VIDEO_PROVIDERS]?.models[0]?.id,
            };
        if (!custom && !providerConfig.apiKey) throw new Error('VIDEO_PROVIDER_NOT_CONFIGURED');
        const result = await this.execution.external(
          key,
          request,
          'media',
          providerId,
          async (signal) => {
            const options = normalizeVideoOptions(providerId, {
              prompt: request.prompt,
              aspectRatio: request.aspectRatio as '16:9',
              signal,
            });
            const output = custom
              ? await withMediaProviderFetch(providerConfig.baseUrl!, (fetcher) =>
                  generateVideo({ ...providerConfig, fetcher }, options),
                )
              : await generateVideo(providerConfig, options);
            signal.throwIfAborted();
            const bytes = output.bytes?.length
              ? Buffer.from(output.bytes)
              : output.base64
                ? Buffer.from(output.base64, 'base64')
                : output.url
                  ? await download(
                      output.url,
                      signal,
                      this.input.budget?.maxAssetBytes ?? 100_000_000,
                    )
                  : null;
            if (!bytes?.length) throw new Error('INVALID_VIDEO_OUTPUT');
            signal.throwIfAborted();
            return this.assets.write(
              `scene:${outline.id}:${key}`,
              bytes,
              output.mimeType || 'video/mp4',
            );
          },
          true,
        );
        if (result) mapping[request.elementId] = result;
      }
    }
    if (scene.type === 'slide') {
      for (const element of scene.content.canvas.elements) {
        if (element.type !== 'image' && element.type !== 'video') continue;
        const ref = element.type === 'video' ? (element.mediaRef ?? element.src) : element.src;
        if (ref && mapping[ref]) element.src = mapping[ref]!;
      }
    }
    return scene;
  }

  async tts(original: Scene, agents: AgentInfo[] = []): Promise<Scene> {
    if (!this.input.tts?.enabled || this.input.tts.providerId === 'browser-native-tts')
      return original;
    if (this.mediaConfig?.ttsEnabled === false) return original;
    const defaultProviderId = (this.input.tts.providerId ??
      Object.entries(getServerTTSProviders()).find(
        ([id, info]) => id !== 'browser-native-tts' && !info.disabled,
      )?.[0]) as TTSProviderId | undefined;
    if (!defaultProviderId) throw new Error('TTS_PROVIDER_NOT_CONFIGURED');
    // SpeechAction is teacher narration; other agent turns are runtime discussions.
    const agent = agents.find((candidate) => candidate.role === 'teacher');
    const override = agent
      ? (this.input.tts.agentVoiceOverrides?.[agent.id] ??
        this.input.agents?.items?.find((item) => item.id === agent.id)?.voiceConfig)
      : undefined;
    const selectedV2Voice =
      this.mediaConfig?.version === 2
        ? resolveEffectiveSessionVoice(mediaConfigVoiceSource(this.mediaConfig), {
            providerId: override?.providerId ?? this.input.tts.providerId,
            modelId: override?.modelId ?? this.input.tts.modelId,
            voiceId: override?.voiceId ?? this.input.tts.voice,
          })
        : undefined;
    if (this.mediaConfig?.version === 2 && this.mediaConfig.ttsEnabled === true && !selectedV2Voice)
      throw new Error('TTS_PROVIDER_NOT_CONFIGURED');
    const selectedProviderId = (selectedV2Voice?.providerId ??
      override?.providerId ??
      defaultProviderId) as TTSProviderId;
    const scene = structuredClone(original);
    scene.actions = (scene.actions ?? []).flatMap((action) => {
      return splitLongSpeechActions([action], selectedProviderId);
    });
    await mapBounded(scene.actions, 2, async (action) => {
      if (action.type !== 'speech' || !action.text) return;
      const providerId = selectedProviderId;
      if (providerId === 'browser-native-tts') return;
      if (isServerProviderDisabled('tts', providerId))
        throw new Error('TTS_PROVIDER_NOT_CONFIGURED');
      const provider = TTS_PROVIDERS[providerId as keyof typeof TTS_PROVIDERS];
      const voice =
        selectedV2Voice?.voice ??
        override?.voiceId ??
        this.input.tts!.voice ??
        DEFAULT_TTS_VOICES[providerId as keyof typeof DEFAULT_TTS_VOICES];
      if (providerId === 'voxcpm-tts' && voice?.startsWith('voxcpm:profile:'))
        throw new Error('TTS_VOICE_REQUIRES_EXPLICIT_BINDING');
      const providerOptions =
        providerId === 'voxcpm-tts' && (!voice || voice === VOXCPM_AUTO_VOICE_ID)
          ? {
              voiceMode: 'auto',
              voicePrompt: buildAutoVoxCPMVoicePrompt({
                agentName: agent?.name,
                role: agent?.role,
                persona: agent?.persona,
                locale: this.input.locale,
              }),
            }
          : undefined;
      const key = `tts:${scene.outlineId}:${action.id}`;
      const modelId =
        selectedV2Voice?.modelId ??
        override?.modelId ??
        this.input.tts!.modelId ??
        DEFAULT_TTS_MODELS[providerId as keyof typeof DEFAULT_TTS_MODELS] ??
        '';
      const speed = action.speed ?? this.input.tts!.speed ?? selectedV2Voice?.speed;
      const snapshot =
        selectedV2Voice ??
        (this.mediaConfig?.version === 1
          ? this.mediaConfig.tts?.find(
              (candidate) =>
                candidate.providerId === providerId &&
                candidate.modelId === modelId &&
                candidate.voice === voice,
            )
          : undefined);
      if (this.mediaConfig?.ttsEnabled === true && (!snapshot || !snapshot.enabled)) {
        throw new Error('TTS_PROVIDER_NOT_CONFIGURED');
      }
      const custom = providerId.startsWith('custom-tts-');
      const providerConfig = custom
        ? parseCustomTTSProviderConfig(
            providerId as Parameters<typeof parseCustomTTSProviderConfig>[0],
            customSnapshotInput(snapshot),
          )
        : {
            providerId,
            apiKey: resolveTTSApiKey(providerId, snapshot?.apiKey),
            baseUrl: resolveTTSBaseUrl(providerId, snapshot?.baseUrl),
            voice,
            modelId,
            speed,
            providerOptions: { ...snapshot?.providerOptions, ...providerOptions },
          };
      if (provider?.requiresApiKey && !providerConfig.apiKey)
        throw new Error('TTS_PROVIDER_NOT_CONFIGURED');
      action.audioId = await this.execution.external(
        key,
        { text: action.text, voice, providerId, modelId, speed, providerOptions },
        'tts',
        providerId,
        async (signal, lifecycle) => {
          const runtimeConfig = {
            ...providerConfig,
            speed,
            providerOptions: { ...snapshot?.providerOptions, ...providerOptions },
            signal,
          };
          const restrictedEndpoint =
            custom || providerId === 'voxcpm-tts' || providerId === 'lemonade-tts';
          const result = restrictedEndpoint
            ? await withMediaProviderFetch(runtimeConfig.baseUrl!, (fetcher) =>
                generateTTS({ ...runtimeConfig, fetcher }, action.text),
              )
            : await generateTTS(runtimeConfig, action.text);
          signal.throwIfAborted();
          if (!result.audio.length) throw new Error('EMPTY_TTS_OUTPUT');
          lifecycle.markResponseReceived();
          return this.assets.write(
            `scene:${scene.outlineId}:${key}`,
            result.audio,
            result.format === 'wav'
              ? 'audio/wav'
              : result.format === 'opus'
                ? 'audio/opus'
                : 'audio/mpeg',
          );
        },
      );
    });
    return scene;
  }
}
