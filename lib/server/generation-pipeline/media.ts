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
import type { PipelineAssets } from './services';
import { PipelineExecution, mapBounded } from './execution';

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

export class GenerationMediaServices {
  constructor(
    readonly execution: PipelineExecution,
    readonly input: GenerationInput,
    readonly assets: PipelineAssets,
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
        const providerId = (this.input.media?.image?.providerId ??
          Object.entries(getServerImageProviders()).find(([, info]) => !info.disabled)?.[0]) as
          | ImageProviderId
          | undefined;
        if (
          !providerId ||
          !getServerImageProviders()[providerId] ||
          getServerImageProviders()[providerId]?.disabled
        )
          throw new Error('IMAGE_PROVIDER_NOT_CONFIGURED');
        const provider = IMAGE_PROVIDERS[providerId];
        const apiKey = resolveImageApiKey(providerId);
        if (provider?.requiresApiKey && !apiKey) throw new Error('IMAGE_PROVIDER_NOT_CONFIGURED');
        const result = await this.execution.external(
          key,
          request,
          'media',
          providerId,
          async (signal) => {
            const output = await generateImage(
              {
                providerId,
                apiKey,
                baseUrl: resolveImageBaseUrl(providerId),
                model:
                  resolveImageModel(providerId, this.input.media?.image?.modelId) ??
                  provider?.models[0]?.id,
              },
              {
                prompt: request.prompt,
                aspectRatio: request.aspectRatio ?? '16:9',
                signal,
              },
            );
            signal.throwIfAborted();
            const bytes = output.base64
              ? Buffer.from(output.base64, 'base64')
              : output.url
                ? await download(output.url, signal, 20 * 1024 * 1024)
                : null;
            if (!bytes?.length || bytes.length > 20 * 1024 * 1024)
              throw new Error('INVALID_IMAGE_OUTPUT');
            signal.throwIfAborted();
            return this.assets.write(`scene:${outline.id}:${key}`, bytes, 'image/png');
          },
          true,
        );
        if (result) mapping[request.elementId] = result;
      } else {
        const providerId = (this.input.media?.video?.providerId ??
          Object.entries(getServerVideoProviders()).find(([, info]) => !info.disabled)?.[0]) as
          | VideoProviderId
          | undefined;
        if (
          !providerId ||
          !getServerVideoProviders()[providerId] ||
          getServerVideoProviders()[providerId]?.disabled
        )
          throw new Error('VIDEO_PROVIDER_NOT_CONFIGURED');
        const apiKey = resolveVideoApiKey(providerId);
        if (!apiKey) throw new Error('VIDEO_PROVIDER_NOT_CONFIGURED');
        const result = await this.execution.external(
          key,
          request,
          'media',
          providerId,
          async (signal) => {
            const output = await generateVideo(
              {
                providerId,
                apiKey,
                baseUrl: resolveVideoBaseUrl(providerId),
                model:
                  resolveVideoModel(providerId, this.input.media?.video?.modelId) ??
                  VIDEO_PROVIDERS[providerId]?.models[0]?.id,
              },
              normalizeVideoOptions(providerId, {
                prompt: request.prompt,
                aspectRatio: request.aspectRatio as '16:9',
                signal,
              }),
            );
            signal.throwIfAborted();
            const bytes = await download(
              output.url,
              signal,
              this.input.budget?.maxAssetBytes ?? 100_000_000,
            );
            signal.throwIfAborted();
            return this.assets.write(`scene:${outline.id}:${key}`, bytes, 'video/mp4');
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
    const scene = structuredClone(original);
    scene.actions = (scene.actions ?? []).flatMap((action) => {
      return splitLongSpeechActions(
        [action],
        (override?.providerId ?? defaultProviderId) as TTSProviderId,
      );
    });
    await mapBounded(scene.actions, 2, async (action) => {
      if (action.type !== 'speech' || !action.text) return;
      const providerId = (override?.providerId ?? defaultProviderId) as TTSProviderId;
      if (providerId === 'browser-native-tts') return;
      if (!getServerTTSProviders()[providerId] || getServerTTSProviders()[providerId]?.disabled)
        throw new Error('TTS_PROVIDER_NOT_CONFIGURED');
      const provider = TTS_PROVIDERS[providerId as keyof typeof TTS_PROVIDERS];
      const apiKey = resolveTTSApiKey(providerId);
      if (provider?.requiresApiKey && !apiKey) throw new Error('TTS_PROVIDER_NOT_CONFIGURED');
      const voice =
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
        override?.modelId ??
        this.input.tts!.modelId ??
        DEFAULT_TTS_MODELS[providerId as keyof typeof DEFAULT_TTS_MODELS] ??
        '';
      const speed = action.speed ?? this.input.tts!.speed;
      action.audioId = await this.execution.external(
        key,
        { text: action.text, voice, providerId, modelId, speed, providerOptions },
        'tts',
        providerId,
        async (signal) => {
          const result = await generateTTS(
            {
              providerId,
              apiKey,
              baseUrl: resolveTTSBaseUrl(providerId),
              voice,
              modelId,
              speed,
              providerOptions,
              signal,
            },
            action.text,
          );
          signal.throwIfAborted();
          if (!result.audio.length) throw new Error('EMPTY_TTS_OUTPUT');
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
