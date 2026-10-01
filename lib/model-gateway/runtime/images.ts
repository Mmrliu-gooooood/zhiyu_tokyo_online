/**
 * Image inputs: data URIs are decoded locally; http(s) URLs are downloaded by
 * the gateway under SSRF checks, DNS pinning, no redirects and a size cap.
 * The AI SDK used to fetch image URLs on its own, an unguarded SSRF surface.
 */
import { createTransport } from './transport';
import {
  DownloadByteBudget,
  MAX_REMOTE_IMAGE_BATCH_BYTES,
  MAX_REMOTE_IMAGE_BYTES,
  readResponseBodyWithLimit,
} from '@/lib/server/bounded-download';
import type { GatewayMessage, ImageContent, ResolvedMessage, TextContent } from '../types';

export class ImageInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageInputError';
  }
}

export interface ResolveImagesOptions {
  /** When false, images are dropped (and reported) instead of sent. */
  vision: boolean;
  signal?: AbortSignal;
  /** Test seam for downloads. */
  fetchImage?: (url: string, signal?: AbortSignal) => Promise<ImageContent>;
}

export interface ResolvedImages {
  messages: ResolvedMessage[];
  droppedImages: number;
}

const ALLOWED_MIME = /^image\/(png|jpe?g|gif|webp)$/i;

async function downloadImage(url: string, signal?: AbortSignal, budget?: DownloadByteBudget) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ImageInputError('Only http(s) and data: image URLs are supported');
  }
  const { fetch } = createTransport({ endpoint: 'user' });
  const response = await fetch(url, { signal });
  if (!response.ok) throw new ImageInputError(`Image download failed with HTTP ${response.status}`);
  const mimeType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim();
  if (!ALLOWED_MIME.test(mimeType)) {
    await response.body?.cancel().catch(() => undefined);
    throw new ImageInputError('Image URL did not return a supported image type');
  }
  const bytes = await readResponseBodyWithLimit(response, {
    maxBytes: MAX_REMOTE_IMAGE_BYTES,
    aggregateBudget: budget,
  });
  return { type: 'image', data: bytes.toString('base64'), mimeType } satisfies ImageContent;
}

export async function resolveImages(
  messages: readonly GatewayMessage[],
  options: ResolveImagesOptions,
): Promise<ResolvedImages> {
  const budget = new DownloadByteBudget(MAX_REMOTE_IMAGE_BATCH_BYTES);
  let droppedImages = 0;
  const resolved: ResolvedMessage[] = [];
  for (const message of messages) {
    if (message.role === 'user' && Array.isArray(message.content)) {
      const content: (TextContent | ImageContent)[] = [];
      for (const part of message.content) {
        if (part.type === 'text') content.push(part);
        else if (!options.vision) droppedImages += 1;
        else if (part.type === 'image') content.push(part);
        else {
          content.push(
            options.fetchImage
              ? await options.fetchImage(part.url, options.signal)
              : await downloadImage(part.url, options.signal, budget),
          );
        }
      }
      resolved.push({ ...message, content: content.length > 0 ? content : '' });
    } else if (message.role === 'toolResult' && !options.vision) {
      const content = message.content.filter((part) => part.type !== 'image');
      droppedImages += message.content.length - content.length;
      resolved.push({ ...message, content });
    } else {
      resolved.push(message as ResolvedMessage);
    }
  }
  return { messages: resolved, droppedImages };
}
