import type {
  ImageGenerationConfig,
  ImageGenerationOptions,
  ImageGenerationResult,
} from '../types';
import {
  decodeBase64,
  joinProtocolUrl,
  protocolHeaders,
  requireCustomProtocolConfig,
  readResponseTextWithLimit,
  throwSubmissionError,
} from './custom-protocol-utils';

export type CustomImageProtocol = 'openai-images' | 'siliconflow-images' | 'openrouter-images';

type RuntimeImageConfig = ImageGenerationConfig & {
  protocol?: CustomImageProtocol;
  requiresApiKey?: boolean;
};

type ExtendedImageResult = ImageGenerationResult & {
  mimeType?: string;
  bytes?: Uint8Array;
};

interface InlineImagePayload {
  url?: string;
  b64_json?: string;
  media_type?: string;
}

function imageDimensions(options: ImageGenerationOptions): { width: number; height: number } {
  return { width: options.width || 1024, height: options.height || 1024 };
}

function parseInlineImage(
  image: InlineImagePayload,
  dimensions: { width: number; height: number },
  protocol: CustomImageProtocol,
): ExtendedImageResult {
  let base64 = image.b64_json;
  let mimeType = image.media_type;
  let url = image.url;

  const dataUrl = image.url?.match(/^data:([^;,]+);base64,([\s\S]+)$/);
  if (dataUrl) {
    mimeType ||= dataUrl[1];
    base64 ||= dataUrl[2];
    url = undefined;
  }

  if (!url && !base64) {
    throw new Error(`${protocol} returned an empty image response`);
  }
  if (mimeType?.toLowerCase() === 'image/svg+xml') {
    throw new Error(`${protocol} returned unsupported SVG media`);
  }

  return {
    url,
    base64,
    mimeType,
    bytes: base64 ? decodeBase64(base64) : undefined,
    ...dimensions,
  };
}

function resolveProtocol(config: RuntimeImageConfig): CustomImageProtocol {
  switch (config.protocol) {
    case 'openai-images':
    case 'siliconflow-images':
    case 'openrouter-images':
      return config.protocol;
    default:
      throw new Error(
        `Custom image provider ${String(config.providerId)} requires a supported explicit protocol`,
      );
  }
}

export async function generateWithCustomImageProtocol(
  config: RuntimeImageConfig,
  options: ImageGenerationOptions,
): Promise<ImageGenerationResult> {
  const protocol = resolveProtocol(config);
  const { baseUrl, model } = requireCustomProtocolConfig(config, protocol);
  const dimensions = imageDimensions(options);
  const relativePath = protocol === 'openrouter-images' ? 'images' : 'images/generations';
  const body: Record<string, unknown> = {
    model,
    prompt: options.prompt,
  };

  if (protocol === 'siliconflow-images') {
    body.image_size = `${dimensions.width}x${dimensions.height}`;
    if (options.negativePrompt) body.negative_prompt = options.negativePrompt;
  } else {
    if (protocol === 'openai-images') body.n = 1;
    body.size = `${dimensions.width}x${dimensions.height}`;
  }

  const response = await (config.fetcher ?? fetch)(joinProtocolUrl(baseUrl, relativePath), {
    method: 'POST',
    redirect: 'manual',
    headers: protocolHeaders(config, true),
    body: JSON.stringify(body),
    signal: options.signal,
  });

  if (!response.ok) {
    return throwSubmissionError(response, protocol, config.apiKey);
  }

  const payload = JSON.parse(await readResponseTextWithLimit(response, 30 * 1024 * 1024)) as {
    data?: InlineImagePayload[];
    images?: InlineImagePayload[];
  };
  const image = protocol === 'siliconflow-images' ? payload.images?.[0] : payload.data?.[0];
  if (!image) throw new Error(`${protocol} returned an empty image response`);

  return parseInlineImage(image, dimensions, protocol);
}
