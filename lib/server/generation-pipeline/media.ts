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
import { recordGenerationUsage } from '@/lib/server/usage-storage';
import type { PipelineAssets } from './services';
import { PipelineExecution, mapBounded } from './execution';
import {
  mediaConfigVoiceSource,
  resolveEffectiveSessionVoice,
  type EffectiveVoiceBinding,
} from '@/lib/server/agent-runtime/effective-voice-directory';
import {
  platformImageExecutionOptions,
  platformVideoExecutionOptions,
  resolveProviderSelection,
} from '@/lib/server/resolve-provider-selection';

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

/** Idempotency key for a worker TTS step's usage_events row. */
export function workerTTSUsageEventKey(jobId: string, stepKey: string): string {
  return `generation:${jobId}:${stepKey}`;
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
        const selected = this.input.media?.image;
        const snapshot = this.mediaConfig?.image;
        const platform = selected && 'source' in selected && selected.source === 'platform';
        const platformConfig =
          platform && snapshot && 'source' in snapshot && snapshot.source === 'platform'
            ? snapshot
            : undefined;
        if (
          platform &&
          (!platformConfig ||
            platformConfig.defaultId !== selected.defaultId ||
            (selected.revision && selected.revision !== platformConfig.revision))
        ) {
          throw new Error('IMAGE_PROVIDER_NOT_CONFIGURED');
        }
        const selectedSnapshot =
          !platform &&
          selected &&
          'providerId' in selected &&
          snapshot &&
          'providerId' in snapshot &&
          snapshot.providerId === selected.providerId
            ? snapshot
            : undefined;
        const resolvedSelection = platform
          ? resolveProviderSelection({
              capability: 'image',
              source: 'platform',
              defaultId: selected.defaultId,
            })
          : selected && 'providerId' in selected
            ? resolveProviderSelection({
                capability: 'image',
                source: 'source' in selected ? selected.source : undefined,
                providerId: selected.providerId,
                modelId: selected.modelId,
                apiKey: selectedSnapshot?.apiKey,
                baseUrl: selectedSnapshot?.baseUrl,
              })
            : undefined;
        if (platform && platformConfig?.revision !== resolvedSelection?.revision) {
          throw new Error('IMAGE_PROVIDER_NOT_CONFIGURED');
        }
        const providerId = (resolvedSelection?.providerId ??
          Object.entries(getServerImageProviders()).find(([, info]) => !info.disabled)?.[0]) as
          | ImageProviderId
          | undefined;
        if (!providerId || isServerProviderDisabled('image', providerId))
          throw new Error('IMAGE_PROVIDER_NOT_CONFIGURED');
        if (
          this.mediaConfig?.imageEnabled === true &&
          !platform &&
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
              customSnapshotInput(selectedSnapshot),
              selected && 'modelId' in selected ? selected.modelId : undefined,
            )
          : {
              providerId: providerId as keyof typeof IMAGE_PROVIDERS,
              apiKey: resolvedSelection ? resolvedSelection.apiKey : resolveImageApiKey(providerId),
              baseUrl: resolvedSelection
                ? resolvedSelection.baseUrl
                : resolveImageBaseUrl(providerId),
              model: resolvedSelection ? resolvedSelection.modelId : resolveImageModel(providerId),
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
              ...(platform && resolvedSelection
                ? platformImageExecutionOptions(resolvedSelection)
                : {}),
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
        const selected = this.input.media?.video;
        const snapshot = this.mediaConfig?.video;
        const platform = selected && 'source' in selected && selected.source === 'platform';
        const platformConfig =
          platform && snapshot && 'source' in snapshot && snapshot.source === 'platform'
            ? snapshot
            : undefined;
        if (
          platform &&
          (!platformConfig ||
            platformConfig.defaultId !== selected.defaultId ||
            (selected.revision && selected.revision !== platformConfig.revision))
        ) {
          throw new Error('VIDEO_PROVIDER_NOT_CONFIGURED');
        }
        const selectedSnapshot =
          !platform &&
          selected &&
          'providerId' in selected &&
          snapshot &&
          'providerId' in snapshot &&
          snapshot.providerId === selected.providerId
            ? snapshot
            : undefined;
        const resolvedSelection = platform
          ? resolveProviderSelection({
              capability: 'video',
              source: 'platform',
              defaultId: selected.defaultId,
            })
          : selected && 'providerId' in selected
            ? resolveProviderSelection({
                capability: 'video',
                source: 'source' in selected ? selected.source : undefined,
                providerId: selected.providerId,
                modelId: selected.modelId,
                apiKey: selectedSnapshot?.apiKey,
                baseUrl: selectedSnapshot?.baseUrl,
              })
            : undefined;
        if (platform && platformConfig?.revision !== resolvedSelection?.revision) {
          throw new Error('VIDEO_PROVIDER_NOT_CONFIGURED');
        }
        const providerId = (resolvedSelection?.providerId ??
          Object.entries(getServerVideoProviders()).find(([, info]) => !info.disabled)?.[0]) as
          | VideoProviderId
          | undefined;
        if (!providerId || isServerProviderDisabled('video', providerId))
          throw new Error('VIDEO_PROVIDER_NOT_CONFIGURED');
        if (
          this.mediaConfig?.videoEnabled === true &&
          !platform &&
          (!selectedSnapshot || !selectedSnapshot.enabled)
        )
          throw new Error('VIDEO_PROVIDER_NOT_CONFIGURED');
        const custom = providerId.startsWith('custom-video-');
        const providerConfig = custom
          ? parseCustomVideoProviderConfig(
              providerId as Parameters<typeof parseCustomVideoProviderConfig>[0],
              customSnapshotInput(selectedSnapshot),
              selected && 'modelId' in selected ? selected.modelId : undefined,
            )
          : {
              providerId: providerId as keyof typeof VIDEO_PROVIDERS,
              apiKey: resolvedSelection ? resolvedSelection.apiKey : resolveVideoApiKey(providerId),
              baseUrl: resolvedSelection
                ? resolvedSelection.baseUrl
                : resolveVideoBaseUrl(providerId),
              model: resolvedSelection ? resolvedSelection.modelId : resolveVideoModel(providerId),
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
              ...(platform && resolvedSelection
                ? platformVideoExecutionOptions(resolvedSelection)
                : {}),
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
    const platform = this.input.tts.source === 'platform';
    const platformSelection = platform
      ? resolveProviderSelection({
          capability: 'tts',
          source: 'platform',
          defaultId: this.input.tts.defaultId,
          voiceId: this.input.tts.voice,
        })
      : undefined;
    const platformSnapshot =
      platform && this.mediaConfig?.version === 3
        ? this.mediaConfig.ttsProviders?.find(
            (candidate) =>
              candidate.source === 'platform' && candidate.defaultId === this.input.tts?.defaultId,
          )
        : undefined;
    const platformDirectory =
      platform && this.mediaConfig?.version === 3
        ? this.mediaConfig.ttsVoiceDirectory?.find(
            (candidate) =>
              candidate.source === 'platform' && candidate.defaultId === this.input.tts?.defaultId,
          )
        : undefined;
    if (
      platform &&
      (!platformSnapshot ||
        !platformDirectory ||
        (platformSnapshot.source === 'platform' ? platformSnapshot.revision : undefined) !==
          platformSelection?.revision ||
        (platformDirectory.source === 'platform' ? platformDirectory.revision : undefined) !==
          platformSelection?.revision ||
        (this.input.tts.revision && this.input.tts.revision !== platformSelection?.revision))
    ) {
      throw new Error('TTS_PROVIDER_NOT_CONFIGURED');
    }
    const defaultProviderId = (platformSelection?.providerId ??
      this.input.tts.providerId ??
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
    const overrideIdentity = override as
      | Pick<EffectiveVoiceBinding, 'source' | 'defaultId' | 'revision'>
      | undefined;
    const selectedSnapshotVoice =
      this.mediaConfig?.version === 2 || this.mediaConfig?.version === 3
        ? resolveEffectiveSessionVoice(
            mediaConfigVoiceSource(this.mediaConfig),
            override
              ? {
                  source: overrideIdentity?.source,
                  defaultId: overrideIdentity?.defaultId,
                  revision: overrideIdentity?.revision,
                  providerId: override.providerId,
                  modelId: override.modelId,
                  voiceId: override.voiceId,
                }
              : platform
                ? {
                    source: 'platform',
                    defaultId: this.input.tts.defaultId,
                    revision: this.input.tts.revision,
                    voiceId: this.input.tts.voice,
                  }
                : {
                    source: this.input.tts.source,
                    providerId: this.input.tts.providerId,
                    modelId: this.input.tts.modelId,
                    voiceId: this.input.tts.voice,
                  },
          )
        : undefined;
    if (
      (this.mediaConfig?.version === 2 || this.mediaConfig?.version === 3) &&
      this.mediaConfig.ttsEnabled === true &&
      !selectedSnapshotVoice
    )
      throw new Error('TTS_PROVIDER_NOT_CONFIGURED');
    const selectedProviderId = (selectedSnapshotVoice?.providerId ?? defaultProviderId) as
      | TTSProviderId
      | undefined;
    if (!selectedProviderId) throw new Error('TTS_PROVIDER_NOT_CONFIGURED');
    const selectedPlatform = selectedSnapshotVoice?.source === 'platform';
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
        selectedSnapshotVoice?.voice ??
        (selectedPlatform
          ? this.input.tts!.voice || platformSelection?.platformParameters?.ttsVoice
          : undefined) ??
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
        selectedSnapshotVoice?.modelId ??
        override?.modelId ??
        this.input.tts!.modelId ??
        DEFAULT_TTS_MODELS[providerId as keyof typeof DEFAULT_TTS_MODELS] ??
        '';
      const speed = action.speed ?? this.input.tts!.speed ?? selectedSnapshotVoice?.speed;
      const snapshot =
        selectedSnapshotVoice ??
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
      const ownerConfigured = !!snapshot && 'source' in snapshot && snapshot.source === 'user';
      const providerConfig = custom
        ? parseCustomTTSProviderConfig(
            providerId as Parameters<typeof parseCustomTTSProviderConfig>[0],
            customSnapshotInput(snapshot),
          )
        : {
            providerId,
            apiKey: ownerConfigured
              ? snapshot.apiKey
              : resolveTTSApiKey(providerId, snapshot?.apiKey),
            baseUrl: ownerConfigured
              ? snapshot.baseUrl
              : resolveTTSBaseUrl(providerId, snapshot?.baseUrl),
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
            // Only Pro opts in, and the adapter enforces its single-request boundary.
            ...(this.input.source?.kind === 'pro' ? { retryPreSendDns: true } : {}),
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
          // The provider has billed these characters. The deterministic key keeps
          // a re-run of the same step (resume, persist/commit retry) to one row.
          void recordGenerationUsage({
            kind: 'tts',
            unit: 'character',
            providerId,
            modelId,
            quantity: action.text.length,
            ownerId: this.execution.lease.ownerId,
            jobId: this.execution.lease.jobId,
            eventKey: workerTTSUsageEventKey(this.execution.lease.jobId, key),
          });
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
