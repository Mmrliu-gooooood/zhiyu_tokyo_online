/**
 * LangChain / LangGraph chat model over the gateway (plan 3.12). Replaces
 * lib/orchestration/ai-sdk-adapter.ts: same `_generate` / `streamGenerate`
 * surface, but every call goes through the gateway pipeline with the
 * resolved ModelBinding (thinking travels with it).
 */
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type { ChatResult } from '@langchain/core/outputs';

import { createLogger } from '@/lib/logger';
// The public entry (not ../runtime/gateway) so business-test module mocks apply.
import {
  fromChatTurns,
  gateway as defaultGateway,
  type ChatTurn,
  type ModelBinding,
  type ModelGateway,
} from '@/lib/model-gateway';

const log = createLogger('GatewayLangGraphAdapter');

/** Stream chunk types for streaming generation. */
export type StreamChunk =
  | { type: 'delta'; content: string }
  | {
      type: 'tool_calls';
      toolCalls: {
        id: string;
        index: number;
        type: 'function';
        function: { name: string; arguments: string };
      }[];
    }
  | { type: 'done'; content: string };

function messageText(message: BaseMessage): string {
  return typeof message.content === 'string' ? message.content : message.text;
}

/** LangChain messages → plain chat turns (unknown message kinds count as user turns). */
function toChatTurns(messages: BaseMessage[]): ChatTurn[] {
  return messages.map((message) => ({
    role:
      message instanceof AIMessage
        ? 'assistant'
        : message instanceof SystemMessage
          ? 'system'
          : 'user',
    content: messageText(message),
  }));
}

export class GatewayLangGraphAdapter extends BaseChatModel {
  private readonly binding: ModelBinding;
  private readonly gateway: ModelGateway;

  constructor(binding: ModelBinding, gateway: ModelGateway = defaultGateway) {
    super({});
    this.binding = binding;
    this.gateway = gateway;
  }

  _llmType(): string {
    return 'model-gateway';
  }

  _combineLLMOutput() {
    return {};
  }

  async _generate(
    messages: BaseMessage[],
    options?: this['ParsedCallOptions'],
    _runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    try {
      const result = await this.gateway.complete(
        this.binding,
        fromChatTurns(toChatTurns(messages)),
        { source: 'chat-adapter', ...(options?.signal ? { signal: options.signal } : {}) },
      );
      const content = result.text || '';
      log.info('[Gateway Adapter] Response:', { textLength: content.length });
      return {
        generations: [{ text: content, message: new AIMessage({ content }) }],
        llmOutput: {},
      };
    } catch (error) {
      log.error('[Gateway Adapter Error]', error);
      throw error;
    }
  }

  /**
   * Stream text deltas, then `done` with the full content. A terminal model
   * error is thrown (as the AI SDK textStream did).
   */
  async *streamGenerate(
    messages: BaseMessage[],
    options?: { tools?: Record<string, unknown>; signal?: AbortSignal },
  ): AsyncGenerator<StreamChunk> {
    const stream = this.gateway.stream(this.binding, fromChatTurns(toChatTurns(messages)), {
      source: 'chat-adapter-stream',
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    let fullContent = '';
    for await (const event of stream) {
      if (event.type === 'error') throw event.gatewayError;
      if (event.type === 'text_delta' && event.delta) {
        fullContent += event.delta;
        yield { type: 'delta', content: event.delta };
      }
    }
    yield { type: 'done', content: fullContent };
  }
}
