/**
 * Split inline `<think>…</think>` text into pi thinking blocks.
 *
 * pi only parses reasoning from dedicated fields (`reasoning_content`, …);
 * some local servers (Ollama, a few SiliconFlow models) put it in the text.
 * Enabled per descriptor (`inlineThinkTags`). The output is a valid pi event
 * stream with its own content indexes; native thinking / tool-call blocks
 * pass through unchanged.
 */
import type {
  AssistantMessage,
  AssistantMessageEvent,
  TextContent,
  ThinkingContent,
} from '../types';

const OPEN = '<think>';
const CLOSE = '</think>';

type Kind = 'text' | 'thinking';

interface TextState {
  inThink: boolean;
  pending: string;
  openIndex?: number;
  openKind?: Kind;
  afterThink: boolean;
}

function partialTagLength(buffer: string, tag: string): number {
  for (let length = Math.min(tag.length - 1, buffer.length); length > 0; length -= 1) {
    if (tag.startsWith(buffer.slice(buffer.length - length))) return length;
  }
  return 0;
}

export async function* splitInlineThinkTags(
  source: AsyncIterable<AssistantMessageEvent>,
): AsyncGenerator<AssistantMessageEvent> {
  let out: AssistantMessage | undefined;
  const nativeIndex = new Map<number, number>();
  const textStates = new Map<number, TextState>();

  const ensureOut = (partial: AssistantMessage): AssistantMessage => {
    out ??= { ...partial, content: [] };
    return out;
  };

  function* close(state: TextState): Generator<AssistantMessageEvent> {
    if (state.openIndex === undefined || !out) return;
    const block = out.content[state.openIndex] as TextContent | ThinkingContent;
    yield block.type === 'text'
      ? { type: 'text_end', contentIndex: state.openIndex, content: block.text, partial: out }
      : {
          type: 'thinking_end',
          contentIndex: state.openIndex,
          content: block.thinking,
          partial: out,
        };
    state.openIndex = undefined;
    state.openKind = undefined;
  }

  function* emit(state: TextState, kind: Kind, raw: string): Generator<AssistantMessageEvent> {
    if (!out) return;
    let text = raw;
    if (kind === 'text' && state.afterThink) {
      text = text.replace(/^\s+/, '');
      if (!text) return;
      state.afterThink = false;
    }
    if (!text) return;
    if (state.openKind !== kind) {
      yield* close(state);
      const index = out.content.length;
      out.content.push(
        kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' },
      );
      state.openIndex = index;
      state.openKind = kind;
      yield kind === 'text'
        ? { type: 'text_start', contentIndex: index, partial: out }
        : { type: 'thinking_start', contentIndex: index, partial: out };
    }
    const index = state.openIndex!;
    const block = out.content[index] as TextContent | ThinkingContent;
    if (block.type === 'text') block.text += text;
    else block.thinking += text;
    yield kind === 'text'
      ? { type: 'text_delta', contentIndex: index, delta: text, partial: out }
      : { type: 'thinking_delta', contentIndex: index, delta: text, partial: out };
  }

  function* feed(state: TextState, delta: string): Generator<AssistantMessageEvent> {
    let buffer = state.pending + delta;
    state.pending = '';
    for (;;) {
      const tag = state.inThink ? CLOSE : OPEN;
      const at = buffer.indexOf(tag);
      if (at < 0) break;
      yield* emit(state, state.inThink ? 'thinking' : 'text', buffer.slice(0, at));
      if (state.inThink) state.afterThink = true;
      state.inThink = !state.inThink;
      buffer = buffer.slice(at + tag.length);
    }
    const hold = partialTagLength(buffer, state.inThink ? CLOSE : OPEN);
    yield* emit(state, state.inThink ? 'thinking' : 'text', buffer.slice(0, buffer.length - hold));
    state.pending = buffer.slice(buffer.length - hold);
  }

  function* flush(state: TextState): Generator<AssistantMessageEvent> {
    if (state.pending) {
      const rest = state.pending;
      state.pending = '';
      yield* emit(state, state.inThink ? 'thinking' : 'text', rest);
    }
    yield* close(state);
  }

  function finalContent(message: AssistantMessage): AssistantMessage['content'] {
    if (!out) return message.content.filter((block) => block.type !== 'text');
    const content = [...out.content];
    for (const [sourceIndex, outIndex] of nativeIndex) {
      const block = message.content[sourceIndex];
      if (block) content[outIndex] = block;
    }
    return content;
  }

  for await (const event of source) {
    switch (event.type) {
      case 'start':
        yield { type: 'start', partial: ensureOut(event.partial) };
        break;
      case 'text_start':
        ensureOut(event.partial);
        textStates.set(event.contentIndex, { inThink: false, pending: '', afterThink: false });
        break;
      case 'text_delta': {
        ensureOut(event.partial);
        let state = textStates.get(event.contentIndex);
        if (!state) {
          state = { inThink: false, pending: '', afterThink: false };
          textStates.set(event.contentIndex, state);
        }
        yield* feed(state, event.delta);
        break;
      }
      case 'text_end': {
        const state = textStates.get(event.contentIndex);
        if (state) yield* flush(state);
        textStates.delete(event.contentIndex);
        break;
      }
      case 'thinking_start':
      case 'toolcall_start': {
        const message = ensureOut(event.partial);
        const index = message.content.length;
        message.content.push(event.partial.content[event.contentIndex]!);
        nativeIndex.set(event.contentIndex, index);
        yield { ...event, contentIndex: index, partial: message };
        break;
      }
      case 'thinking_delta':
      case 'thinking_end':
      case 'toolcall_delta':
      case 'toolcall_end': {
        const message = ensureOut(event.partial);
        const index = nativeIndex.get(event.contentIndex);
        if (index === undefined) break;
        message.content[index] = event.partial.content[event.contentIndex]!;
        yield { ...event, contentIndex: index, partial: message };
        break;
      }
      case 'done': {
        for (const state of textStates.values()) yield* flush(state);
        yield { ...event, message: { ...event.message, content: finalContent(event.message) } };
        return;
      }
      case 'error': {
        for (const state of textStates.values()) yield* flush(state);
        yield { ...event, error: { ...event.error, content: finalContent(event.error) } };
        return;
      }
    }
  }
}
