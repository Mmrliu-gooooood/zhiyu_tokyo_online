import { mediaSubmissionError } from '../generation-errors';
import { runPolledTask } from '../polled-task';
import type {
  VideoGenerationConfig,
  VideoGenerationOptions,
  VideoGenerationResult,
} from '../types';
import {
  dimensionsForVideo,
  joinProtocolUrl,
  protocolHeaders,
  providerHttpError,
  readResponseBytesWithLimit,
  redactProviderText,
  requireCustomProtocolConfig,
} from './custom-protocol-utils';

export type CustomVideoProtocol = 'siliconflow-video' | 'openrouter-video';

type RuntimeVideoConfig = VideoGenerationConfig & {
  protocol?: CustomVideoProtocol;
  requiresApiKey?: boolean;
};

type ExtendedVideoResult = VideoGenerationResult & {
  mimeType?: string;
  bytes?: Uint8Array;
};

const SILICONFLOW_POLL_INTERVAL_MS = 10_000;
const OPENROUTER_POLL_INTERVAL_MS = 30_000;
const MAX_POLL_ATTEMPTS = 60;

function resolveProtocol(config: RuntimeVideoConfig): CustomVideoProtocol {
  switch (config.protocol) {
    case 'siliconflow-video':
    case 'openrouter-video':
      return config.protocol;
    default:
      throw new Error(
        `Custom video provider ${String(config.providerId)} requires a supported explicit protocol`,
      );
  }
}

function siliconFlowSize(aspectRatio?: string): { value: string; width: number; height: number } {
  switch (aspectRatio || '16:9') {
    case '16:9':
      return { value: '1280x720', width: 1280, height: 720 };
    case '9:16':
      return { value: '720x1280', width: 720, height: 1280 };
    case '1:1':
      return { value: '960x960', width: 960, height: 960 };
    default:
      throw new Error(`siliconflow-video does not support aspect ratio ${aspectRatio}`);
  }
}

async function submitSiliconFlow(
  config: RuntimeVideoConfig,
  baseUrl: string,
  model: string,
  options: VideoGenerationOptions,
): Promise<string> {
  const size = siliconFlowSize(options.aspectRatio);
  const response = await (config.fetcher ?? fetch)(joinProtocolUrl(baseUrl, 'video/submit'), {
    method: 'POST',
    redirect: 'manual',
    headers: protocolHeaders(config, true),
    body: JSON.stringify({ model, prompt: options.prompt, image_size: size.value }),
    signal: options.signal,
  });
  if (!response.ok) {
    throw mediaSubmissionError(
      response.status,
      await providerHttpError(response, 'siliconflow-video', config.apiKey, 'submit'),
    );
  }

  const payload = (await response.json()) as { requestId?: string };
  if (!payload.requestId) throw new Error('siliconflow-video returned an empty requestId');
  return payload.requestId;
}

async function generateSiliconFlowVideo(
  config: RuntimeVideoConfig,
  baseUrl: string,
  model: string,
  options: VideoGenerationOptions,
): Promise<VideoGenerationResult> {
  const size = siliconFlowSize(options.aspectRatio);
  return runPolledTask<VideoGenerationResult>({
    submit: async () => ({
      status: 'submitted',
      taskId: await submitSiliconFlow(config, baseUrl, model, options),
    }),
    poll: async (requestId) => {
      const response = await (config.fetcher ?? fetch)(joinProtocolUrl(baseUrl, 'video/status'), {
        method: 'POST',
        redirect: 'manual',
        headers: protocolHeaders(config, true),
        body: JSON.stringify({ requestId }),
        signal: options.signal,
      });
      if (!response.ok) {
        throw new Error(
          await providerHttpError(response, 'siliconflow-video', config.apiKey, 'poll'),
        );
      }

      const payload = (await response.json()) as {
        status?: string;
        reason?: string;
        results?: { videos?: Array<{ url?: string }> };
      };
      if (payload.status === 'Succeed') {
        const url = payload.results?.videos?.[0]?.url;
        if (!url) throw new Error('siliconflow-video task succeeded without a video URL');
        return {
          status: 'done',
          result: {
            url,
            duration: options.duration || 5,
            width: size.width,
            height: size.height,
          },
        };
      }
      if (payload.status === 'Failed') {
        return {
          status: 'failed',
          message: `siliconflow-video task failed: ${redactProviderText(payload.reason, config.apiKey)}`,
        };
      }
      if (payload.status !== 'InQueue' && payload.status !== 'InProgress') {
        throw new Error(`siliconflow-video returned unknown status: ${String(payload.status)}`);
      }
      return { status: 'pending', detail: payload.status };
    },
    intervalMs: SILICONFLOW_POLL_INTERVAL_MS,
    maxAttempts: MAX_POLL_ATTEMPTS,
    label: 'siliconflow-video',
    signal: options.signal,
  });
}

async function downloadOpenRouterVideo(
  config: RuntimeVideoConfig,
  baseUrl: string,
  taskId: string,
  options: VideoGenerationOptions,
): Promise<ExtendedVideoResult> {
  const response = await (config.fetcher ?? fetch)(
    `${joinProtocolUrl(baseUrl, `videos/${encodeURIComponent(taskId)}/content`)}?index=0`,
    {
      method: 'GET',
      redirect: 'manual',
      headers: protocolHeaders(config),
      signal: options.signal,
    },
  );
  if (!response.ok) {
    throw new Error(
      await providerHttpError(response, 'openrouter-video', config.apiKey, 'content'),
    );
  }

  const dimensions = dimensionsForVideo(options.aspectRatio, options.resolution);
  return {
    bytes: await readResponseBytesWithLimit(response, 100 * 1024 * 1024),
    mimeType: response.headers.get('content-type')?.split(';')[0] || 'video/mp4',
    duration: options.duration || 5,
    ...dimensions,
  } as ExtendedVideoResult;
}

async function generateOpenRouterVideo(
  config: RuntimeVideoConfig,
  baseUrl: string,
  model: string,
  options: VideoGenerationOptions,
): Promise<VideoGenerationResult> {
  return runPolledTask<VideoGenerationResult>({
    submit: async () => {
      const body: Record<string, unknown> = { model, prompt: options.prompt };
      if (options.duration) body.duration = options.duration;
      if (options.resolution) body.resolution = options.resolution;
      if (options.aspectRatio) body.aspect_ratio = options.aspectRatio;

      const response = await (config.fetcher ?? fetch)(joinProtocolUrl(baseUrl, 'videos'), {
        method: 'POST',
        redirect: 'manual',
        headers: protocolHeaders(config, true),
        body: JSON.stringify(body),
        signal: options.signal,
      });
      if (!response.ok) {
        throw mediaSubmissionError(
          response.status,
          await providerHttpError(response, 'openrouter-video', config.apiKey, 'submit'),
        );
      }
      const payload = (await response.json()) as { id?: string };
      if (!payload.id) throw new Error('openrouter-video returned an empty job ID');
      return { status: 'submitted', taskId: payload.id };
    },
    poll: async (taskId) => {
      const response = await (config.fetcher ?? fetch)(
        joinProtocolUrl(baseUrl, `videos/${encodeURIComponent(taskId)}`),
        {
          method: 'GET',
          redirect: 'manual',
          headers: protocolHeaders(config),
          signal: options.signal,
        },
      );
      if (!response.ok) {
        throw new Error(
          await providerHttpError(response, 'openrouter-video', config.apiKey, 'poll'),
        );
      }

      const payload = (await response.json()) as { status?: string; error?: unknown };
      if (payload.status === 'completed') {
        return {
          status: 'done',
          result: await downloadOpenRouterVideo(config, baseUrl, taskId, options),
        };
      }
      if (['failed', 'cancelled', 'expired'].includes(payload.status || '')) {
        return {
          status: 'failed',
          message: `openrouter-video task failed (${payload.status}): ${redactProviderText(payload.error, config.apiKey)}`,
        };
      }
      if (payload.status !== 'pending' && payload.status !== 'in_progress') {
        throw new Error(`openrouter-video returned unknown status: ${String(payload.status)}`);
      }
      return { status: 'pending', detail: payload.status };
    },
    intervalMs: OPENROUTER_POLL_INTERVAL_MS,
    maxAttempts: MAX_POLL_ATTEMPTS,
    label: 'openrouter-video',
    signal: options.signal,
  });
}

export async function generateWithCustomVideoProtocol(
  config: RuntimeVideoConfig,
  options: VideoGenerationOptions,
): Promise<VideoGenerationResult> {
  const protocol = resolveProtocol(config);
  const { baseUrl, model } = requireCustomProtocolConfig(config, protocol);
  return protocol === 'siliconflow-video'
    ? generateSiliconFlowVideo(config, baseUrl, model, options)
    : generateOpenRouterVideo(config, baseUrl, model, options);
}
