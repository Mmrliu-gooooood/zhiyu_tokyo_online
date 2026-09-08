import { mediaSubmissionError } from '../generation-errors';

export interface CustomProtocolConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  requiresApiKey?: boolean;
}

export function requireCustomProtocolConfig(
  config: CustomProtocolConfig,
  protocol: string,
): { baseUrl: string; model: string } {
  const baseUrl = config.baseUrl?.trim().replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error(`${protocol} requires an explicit Base URL`);
  }

  const model = config.model?.trim();
  if (!model) {
    throw new Error(`${protocol} requires an explicit model ID`);
  }

  if (config.requiresApiKey !== false && !config.apiKey?.trim()) {
    throw new Error(`${protocol} requires an API key`);
  }

  return { baseUrl, model };
}

export function joinProtocolUrl(baseUrl: string, relativePath: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${relativePath.replace(/^\/+/, '')}`;
}

export function protocolHeaders(
  config: Pick<CustomProtocolConfig, 'apiKey' | 'requiresApiKey'>,
  json = false,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (json) headers['Content-Type'] = 'application/json';
  if (config.requiresApiKey !== false) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }
  return headers;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redactProviderText(value: unknown, apiKey?: string): string {
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return 'Unknown provider error';

  if (apiKey) {
    text = text.replace(new RegExp(escapeRegExp(apiKey), 'g'), '[REDACTED]');
  }
  text = text.replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer [REDACTED]');
  return text.slice(0, 1_000);
}

export async function providerHttpError(
  response: Response,
  protocol: string,
  apiKey: string,
  phase: 'request' | 'submit' | 'poll' | 'content',
): Promise<string> {
  const raw = await readResponseTextWithLimit(response, 64 * 1024).catch(
    () => response.statusText,
  );
  const requestId =
    response.headers.get('x-request-id') || response.headers.get('x-siliconcloud-trace-id');
  const requestSuffix = requestId ? ` (request ${redactProviderText(requestId, apiKey)})` : '';
  return `${protocol} ${phase} failed (${response.status}): ${redactProviderText(raw || response.statusText, apiKey)}${requestSuffix}`;
}

export async function readResponseBytesWithLimit(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`Provider response exceeded ${maxBytes} bytes`);
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error(`Provider response exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readResponseTextWithLimit(
  response: Response,
  maxBytes: number,
): Promise<string> {
  return new TextDecoder().decode(await readResponseBytesWithLimit(response, maxBytes));
}

export async function throwSubmissionError(
  response: Response,
  protocol: string,
  apiKey: string,
): Promise<never> {
  throw mediaSubmissionError(
    response.status,
    await providerHttpError(response, protocol, apiKey, 'request'),
  );
}

export function decodeBase64(base64: string): Uint8Array {
  const decoded = globalThis.atob(base64);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index++) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

export function dimensionsForVideo(
  aspectRatio = '16:9',
  resolution = '720p',
): { width: number; height: number } {
  const edge = resolution === '1080p' ? 1080 : resolution === '480p' ? 480 : 720;
  const [widthRatio, heightRatio] = aspectRatio.split(':').map(Number);
  if (!widthRatio || !heightRatio) return { width: Math.round((edge * 16) / 9), height: edge };
  if (widthRatio >= heightRatio) {
    return { width: Math.round((edge * widthRatio) / heightRatio), height: edge };
  }
  return { width: edge, height: Math.round((edge * heightRatio) / widthRatio) };
}
