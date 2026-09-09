import { DEFAULT_TTS_MODELS, DEFAULT_TTS_VOICES, TTS_PROVIDERS } from '@/lib/audio/constants';
import { generateTTS, TTSRequestTimeoutError } from '@/lib/audio/tts-providers';
import type { TTSProviderId } from '@/lib/audio/types';
import { BROWSER_NATIVE_TTS_PROVIDER_ID } from '@/lib/audio/provider-enablement';
import type { LegacySpeechAction, SpeechAction } from '@/lib/types/action';
import type { GeneratedAgentConfig, Scene } from '@/lib/types/stage';
import {
  getServerTTSProviders,
  resolveTTSApiKey,
  resolveTTSBaseUrl,
  resolveTTSModel,
} from '@/lib/server/provider-config';
import { parseCustomTTSProviderConfig } from '@/lib/server/media-provider-config';
import { persistClassroomMediaBytes } from '@/lib/server/classroom-media-bytes';
import { withMediaProviderFetch } from '@/lib/server/media-provider-fetch';
import { resolveEffectiveSessionVoice } from './effective-voice-directory';

export interface SceneTtsSummary {
  available: boolean;
  changed: boolean;
  generated: number;
  skipped: number;
  failed: string[];
}

export interface SceneTtsInput {
  scene: Scene;
  force: boolean;
  roster?: readonly GeneratedAgentConfig[] | null;
  signal?: AbortSignal;
  /** Fixed, owner-loaded session snapshot. Undefined preserves legacy server selection. */
  providerConfigs?: readonly SceneTtsProviderConfig[];
}

export interface SceneTtsProviderConfig {
  providerId: TTSProviderId;
  protocol?: 'openai-speech';
  apiKey: string;
  baseUrl: string;
  requiresApiKey: boolean;
  enabled: boolean;
  modelId: string;
  voice: string;
  /** Explicit narration fallback selected when no roster voice is bound. */
  default?: boolean;
  speed?: number;
  format?: string;
  providerOptions?: Record<string, unknown>;
}

function enabledProviderIds(): TTSProviderId[] {
  return Object.entries(getServerTTSProviders())
    .filter(([id, config]) => id !== BROWSER_NATIVE_TTS_PROVIDER_ID && !config.disabled)
    .map(([id]) => id as TTSProviderId);
}

function narratorVoice(roster: SceneTtsInput['roster']) {
  return roster?.find((agent) => agent.role === 'teacher' && agent.voiceConfig)?.voiceConfig;
}

function audioMime(format: string) {
  return format === 'wav' ? 'audio/wav' : format === 'ogg' ? 'audio/ogg' : 'audio/mpeg';
}

/** Server-configured narration synthesis into the stage's classroom-media path. */
export async function synthesizeSceneNarration(input: SceneTtsInput): Promise<SceneTtsSummary> {
  const bound = narratorVoice(input.roster);
  const selected = input.providerConfigs
    ? resolveEffectiveSessionVoice(input.providerConfigs, bound)
    : undefined;
  const enabled = input.providerConfigs ? [] : enabledProviderIds();
  const providerId = (selected?.providerId ??
    (bound?.providerId && enabled.includes(bound.providerId as TTSProviderId)
      ? bound.providerId
      : enabled[0])) as TTSProviderId | undefined;
  if (!providerId) {
    return { available: false, changed: false, generated: 0, skipped: 0, failed: [] };
  }
  if ((selected && !selected.enabled) || getServerTTSProviders()[providerId]?.disabled) {
    return { available: false, changed: false, generated: 0, skipped: 0, failed: [] };
  }
  const provider = TTS_PROVIDERS[providerId as keyof typeof TTS_PROVIDERS];
  const customConfig =
    selected && String(providerId).startsWith('custom-tts-')
      ? parseCustomTTSProviderConfig(providerId, {
          id: providerId,
          protocol: selected.protocol,
          apiKey: selected.apiKey,
          baseUrl: selected.baseUrl,
          enabled: selected.enabled,
          requiresApiKey: selected.requiresApiKey,
          modelId: selected.modelId,
          voice: selected.voice,
          speed: selected.speed,
          format: selected.format,
          providerOptions: selected.providerOptions,
        })
      : undefined;
  const apiKey = resolveTTSApiKey(providerId, customConfig?.apiKey ?? selected?.apiKey);
  if ((provider?.requiresApiKey ?? selected?.requiresApiKey) && !apiKey) {
    return { available: false, changed: false, generated: 0, skipped: 0, failed: [] };
  }
  const selectedVoice =
    selected?.voice ||
    (bound?.providerId === providerId && bound.voiceId
      ? bound.voiceId
      : DEFAULT_TTS_VOICES[providerId as keyof typeof DEFAULT_TTS_VOICES] || '');
  const modelId =
    resolveTTSModel(
      providerId,
      selected?.modelId || DEFAULT_TTS_MODELS[providerId as keyof typeof DEFAULT_TTS_MODELS] || '',
      selectedVoice,
    ) || '';
  let generated = 0;
  let skipped = 0;
  const failed: string[] = [];
  for (const action of input.scene.actions ?? []) {
    if (action.type !== 'speech' || !(action as SpeechAction).text) continue;
    const speech = action as SpeechAction;
    if (!input.force && speech.audioId) {
      skipped += 1;
      continue;
    }
    if (input.signal?.aborted) throw new Error('aborted');
    try {
      const runtimeConfig = {
        providerId,
        modelId,
        apiKey,
        baseUrl: resolveTTSBaseUrl(providerId, customConfig?.baseUrl ?? selected?.baseUrl),
        voice: selectedVoice,
        speed: speech.speed ?? selected?.speed,
        format: selected?.format,
        providerOptions: selected?.providerOptions,
        signal: input.signal,
      };
      const restrictedEndpoint =
        customConfig || providerId === 'voxcpm-tts' || providerId === 'lemonade-tts';
      const audio = restrictedEndpoint
        ? await withMediaProviderFetch(runtimeConfig.baseUrl!, (fetcher) =>
            generateTTS({ ...runtimeConfig, fetcher }, speech.text),
          )
        : await generateTTS(runtimeConfig, speech.text);
      if (input.signal?.aborted) throw new Error('aborted');
      // The persisted reference is the RELATIVE classroom-media path (the
      // agent runtime has no request origin; relative stays valid on any
      // deployment origin — see classroom-media-bytes.ts). The browser's
      // narration consumers (timeline status/preview, playback, exports)
      // resolve a speech line through the legacy (audioId, audioUrl) pair:
      // `audioId` alone is never resolvable to bytes client-side, while a
      // present `audioUrl` marks the line voiced and is what the audio
      // element / fetch fallback plays. Stamp the same relative path on both.
      const audioId = await persistClassroomMediaBytes({
        stageId: input.scene.stageId,
        bytes: Buffer.from(audio.audio),
        mime: audioMime(audio.format),
        prefix: `tts-${action.id}`,
        signal: input.signal,
      });
      speech.audioId = audioId;
      (speech as LegacySpeechAction).audioUrl = audioId;
      generated += 1;
    } catch (error) {
      if (input.signal?.aborted) throw error;
      // A hung provider must fail the tool call with the retryable timeout
      // error instead of degrading into a per-action failure: the remaining
      // actions would hit the same hung upstream and the session would wedge.
      if (error instanceof TTSRequestTimeoutError) throw error;
      failed.push(action.id);
    }
  }
  return {
    available: true,
    changed: generated > 0,
    generated,
    skipped,
    failed,
  };
}
