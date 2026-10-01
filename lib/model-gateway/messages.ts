/**
 * Message constructors (isomorphic). pi messages carry timestamps and full
 * assistant metadata; these helpers fill them so call sites stay short.
 */
import type {
  AssistantMessage,
  GatewayUserMessage,
  ImageContent,
  ImageUrlContent,
  TextContent,
  ToolCall,
  ToolResultMessage,
} from './types';

/** An image given as a data URI / base64 payload, or as an http(s) URL to fetch. */
export type ImageInput = string | { url: string } | { data: string; mimeType: string };

const DATA_URI = /^data:([^;,]+);base64,([\s\S]*)$/;

function toImagePart(image: ImageInput): ImageContent | ImageUrlContent {
  if (typeof image === 'string') {
    const match = DATA_URI.exec(image);
    if (match) return { type: 'image', mimeType: match[1], data: match[2] };
    return { type: 'image_url', url: image };
  }
  if ('url' in image) return toImagePart(image.url);
  return { type: 'image', data: image.data, mimeType: image.mimeType };
}

export function userText(text: string, timestamp = Date.now()): GatewayUserMessage {
  return { role: 'user', content: text, timestamp };
}

export function userContent(
  text: string,
  images: readonly ImageInput[] = [],
  timestamp = Date.now(),
): GatewayUserMessage {
  if (images.length === 0) return userText(text, timestamp);
  const content: (TextContent | ImageContent | ImageUrlContent)[] = [];
  if (text) content.push({ type: 'text', text });
  for (const image of images) content.push(toImagePart(image));
  return { role: 'user', content, timestamp };
}

/** Interleaved text / image parts (the generation package's vision prompt shape). */
export type UserPart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: string; mimeType?: string };

/** A user turn from ordered parts; bare base64 images need their `mimeType`. */
export function userParts(parts: readonly UserPart[], timestamp = Date.now()): GatewayUserMessage {
  const content: (TextContent | ImageContent | ImageUrlContent)[] = parts.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.mimeType && !/^(data:|https?:)/i.test(part.image)) {
      return { type: 'image', data: part.image, mimeType: part.mimeType };
    }
    return toImagePart(part.image);
  });
  return { role: 'user', content, timestamp };
}

const ZERO_USAGE: AssistantMessage['usage'] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * A replayed assistant turn. `api`/`provider`/`model` identify the model that
 * produced it; pi converts history from other models conservatively, so pass
 * the real values when known.
 */
export function assistantText(
  text: string,
  origin: { api?: string; provider?: string; model?: string; toolCalls?: ToolCall[] } = {},
  timestamp = Date.now(),
): AssistantMessage {
  const content: AssistantMessage['content'] = [];
  if (text) content.push({ type: 'text', text });
  for (const call of origin.toolCalls ?? []) content.push(call);
  return {
    role: 'assistant',
    content,
    api: origin.api ?? 'unknown',
    provider: origin.provider ?? 'unknown',
    model: origin.model ?? 'unknown',
    usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
    stopReason: origin.toolCalls?.length ? 'toolUse' : 'stop',
    timestamp,
  };
}

export function toolResult(
  call: Pick<ToolCall, 'id' | 'name'>,
  output: string,
  options: { isError?: boolean; timestamp?: number } = {},
): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: 'text', text: output }],
    isError: options.isError ?? false,
    timestamp: options.timestamp ?? Date.now(),
  };
}

/** Plain-text chat history (the shape prompts used with the AI SDK). */
export interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Plain-text chat turns → gateway request fields. System turns are appended to
 * the system prompt in order (they carry instructions such as memory
 * summaries); user / assistant turns become pi messages.
 */
export function fromChatTurns(
  turns: readonly ChatTurn[],
  system?: string,
): { system?: string; messages: (GatewayUserMessage | AssistantMessage)[] } {
  const systemParts = system ? [system] : [];
  const messages: (GatewayUserMessage | AssistantMessage)[] = [];
  const now = Date.now();
  for (const turn of turns) {
    if (turn.role === 'system') systemParts.push(turn.content);
    else if (turn.role === 'user') messages.push(userText(turn.content, now));
    else messages.push(assistantText(turn.content, {}, now));
  }
  return { ...(systemParts.length ? { system: systemParts.join('\n\n') } : {}), messages };
}

/** Concatenate the visible text of an assistant message. */
export function messageText(message: Pick<AssistantMessage, 'content'>): string {
  return message.content
    .filter((block): block is TextContent => block.type === 'text')
    .map((block) => block.text)
    .join('');
}
