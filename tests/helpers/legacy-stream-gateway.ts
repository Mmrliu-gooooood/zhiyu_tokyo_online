/**
 * Test-only ModelGateway that replays AI SDK `streamLLM`-style scripts.
 *
 * Many agent / chat consumer tests script one model turn as AI SDK
 * `fullStream` parts (`text-delta`, `reasoning-delta`, `tool-call`,
 * `finish`, `error`). This shim lets those scripts drive the gateway-based
 * stream fn unchanged: `stream(binding, req, opts)` calls the test's
 * `streamLLM(params, source)` mock with AI-SDK-shaped params (system,
 * messages, tools keyed by name, maxOutputTokens, abortSignal) and turns the
 * returned parts into gateway events. Transport behavior itself is covered by
 * tests/model-gateway; these tests exercise the consumers.
 */
import { createBinding, type BindingFields } from '@/lib/model-gateway/credentials/handles';
import type {
  AssistantMessage,
  GatewayMessage,
  GatewayRequest,
  GatewayStream,
  GatewayStreamEvent,
  ModelBinding,
  ModelGateway,
  ToolCall,
} from '@/lib/model-gateway';

type StreamLLMLike = (
  params: Record<string, unknown>,
  source: string,
) => { fullStream: AsyncIterable<Record<string, unknown>> } | undefined;

function text(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: { type?: string; text?: string }) => (part.type === 'text' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

/** pi messages → AI SDK ModelMessage-like records (what streamLLM used to receive). */
export function toLegacyMessages(messages: GatewayMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role === 'user') out.push({ role: 'user', content: text(message.content) });
    else if (message.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: message.content.flatMap((block): Record<string, unknown>[] =>
          block.type === 'text'
            ? [{ type: 'text', text: block.text }]
            : block.type === 'toolCall'
              ? [
                  {
                    type: 'tool-call',
                    toolCallId: block.id,
                    toolName: block.name,
                    input: block.arguments,
                  },
                ]
              : [],
        ),
      });
    } else if (message.role === 'toolResult') {
      out.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            output: { type: message.isError ? 'error-text' : 'text', value: text(message.content) },
          },
        ],
      });
    }
  }
  return out;
}

function legacyParams(binding: ModelBinding, req: GatewayRequest, signal?: AbortSignal) {
  return {
    model: binding,
    system: req.system,
    messages: toLegacyMessages(req.messages),
    tools: Object.fromEntries(
      (req.tools ?? []).map((tool) => [
        tool.name,
        // AI SDK `jsonSchema()` wrapper shape.
        { description: tool.description, inputSchema: { jsonSchema: tool.parameters } },
      ]),
    ),
    toolChoice: req.toolChoice,
    ...(typeof req.maxOutputTokens === 'number' ? { maxOutputTokens: req.maxOutputTokens } : {}),
    abortSignal: signal,
  };
}

function emptyMessage(binding: ModelBinding): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: binding.model.api,
    provider: binding.model.provider,
    model: binding.model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

/** JSON text inputs are parsed when valid; anything else is passed through as-is. */
function parseArguments(raw: unknown): ToolCall['arguments'] {
  if (typeof raw !== 'string') return raw as ToolCall['arguments'];
  try {
    return JSON.parse(raw) as ToolCall['arguments'];
  } catch {
    return raw as unknown as ToolCall['arguments'];
  }
}

function errorOf(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? 'LLM stream error');
  return Object.assign(new Error(message), { code: 'MODEL_UPSTREAM_UNAVAILABLE', cause: error });
}

async function* replay(
  streamLLM: StreamLLMLike,
  binding: ModelBinding,
  req: GatewayRequest,
  opts: { source: string; signal?: AbortSignal; beforeCall?: () => Promise<void> },
): AsyncGenerator<GatewayStreamEvent> {
  const partial = emptyMessage(binding);
  const fail = (reason: 'error' | 'aborted', error: unknown): GatewayStreamEvent => ({
    type: 'error',
    reason,
    error: { ...partial, stopReason: reason },
    gatewayError: errorOf(error),
  });
  try {
    await opts.beforeCall?.();
    if (opts.signal?.aborted) {
      yield fail('aborted', opts.signal.reason);
      return;
    }
    const result = streamLLM(legacyParams(binding, req, opts.signal), opts.source);
    if (!result) {
      yield fail('error', 'streamLLM mock returned nothing');
      return;
    }
    yield { type: 'start', partial };
    let open: 'text' | 'thinking' | undefined;
    for await (const part of result.fullStream) {
      if (opts.signal?.aborted) {
        yield fail('aborted', opts.signal.reason);
        return;
      }
      const type = part.type as string;
      if (type === 'text-delta' || type === 'text') {
        const delta = String(part.text ?? part.delta ?? part.textDelta ?? '');
        if (!delta) continue;
        if (open !== 'text') {
          partial.content.push({ type: 'text', text: '' });
          open = 'text';
        }
        const index = partial.content.length - 1;
        (partial.content[index] as { text: string }).text += delta;
        yield { type: 'text_delta', contentIndex: index, delta, partial };
      } else if (type === 'reasoning-delta' || type === 'reasoning') {
        const delta = String(part.text ?? part.delta ?? '');
        if (!delta) continue;
        if (open !== 'thinking') {
          partial.content.push({ type: 'thinking', thinking: '' });
          open = 'thinking';
        }
        const index = partial.content.length - 1;
        (partial.content[index] as { thinking: string }).thinking += delta;
        yield { type: 'thinking_delta', contentIndex: index, delta, partial };
      } else if (type === 'tool-call') {
        open = undefined;
        const raw = part.input ?? part.args ?? {};
        const toolCall: ToolCall = {
          type: 'toolCall',
          id: String(part.toolCallId ?? part.id),
          name: String(part.toolName ?? part.name),
          arguments: parseArguments(raw),
        };
        partial.content.push(toolCall);
        const index = partial.content.length - 1;
        yield { type: 'toolcall_start', contentIndex: index, partial };
        yield { type: 'toolcall_end', contentIndex: index, toolCall, partial };
      } else if (type === 'error') {
        yield fail('error', part.error);
        return;
      } else if (type === 'abort') {
        yield fail('aborted', part.reason);
        return;
      } else if (type === 'finish') {
        const hasToolCall = partial.content.some((block) => block.type === 'toolCall');
        const finish = part.finishReason as string | undefined;
        if (finish === 'length') {
          yield { type: 'done', reason: 'length', message: { ...partial, stopReason: 'length' } };
          return;
        }
        if (finish === 'stop' || finish === 'tool-calls') {
          const reason = hasToolCall ? 'toolUse' : 'stop';
          yield { type: 'done', reason, message: { ...partial, stopReason: reason } };
          return;
        }
        yield fail('error', `LLM stream finished with ${finish}`);
        return;
      }
    }
    yield fail('error', 'LLM stream ended without a terminal event');
  } catch (error) {
    yield fail(opts.signal?.aborted ? 'aborted' : 'error', error);
  }
}

/** A ModelGateway whose turns are scripted by an AI SDK-style `streamLLM` mock. */
export function legacyStreamGateway(streamLLM: StreamLLMLike): ModelGateway {
  return {
    stream(binding, req, opts) {
      const events = () => replay(streamLLM, binding, req, opts);
      const stream: GatewayStream = {
        [Symbol.asyncIterator]: events,
        async *textStream() {
          for await (const event of events()) if (event.type === 'text_delta') yield event.delta;
        },
        result: () => {
          throw new Error('legacyStreamGateway: result() is not supported');
        },
      };
      return stream;
    },
    complete() {
      throw new Error('legacyStreamGateway: complete() is not supported');
    },
  };
}

/** A gateway-created binding for consumer tests (inline test key, no real provider). */
export function testBinding(overrides: Record<string, unknown> = {}): ModelBinding {
  const { credentialReady, fingerprint: _fingerprint, ...fields } = overrides;
  return createBinding(
    {
      source: 'user',
      providerId: 'openai',
      modelId: 'test-model',
      modelString: 'openai:test-model',
      model: {
        id: 'test-model',
        name: 'test-model',
        api: 'openai-completions',
        provider: 'openai',
        baseUrl: 'https://api.example.test/v1',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
      upstream: 'pi',
      capabilities: {
        tools: true,
        vision: true,
        reasoning: true,
        contextWindow: 128_000,
        maxOutputTokens: 8_192,
        knownModel: true,
      },
      transforms: { inlineThinkTags: false, payloadPatches: [] },
      funding: { kind: 'byok' },
      endpoint: 'official',
      ...fields,
    } as BindingFields,
    { kind: 'inline-key', apiKey: credentialReady === false ? '' : 'test-key' },
  );
}

/** The legacy `ResolvedModel` fields route tests mock. */
export interface LegacyResolvedLike {
  providerId?: string;
  modelId?: string;
  modelString?: string;
  apiKey?: string;
  thinkingConfig?: unknown;
  modelInfo?: {
    outputWindow?: number;
    contextWindow?: number;
    capabilities?: { tools?: boolean; vision?: boolean };
  } | null;
}

/**
 * A binding from a legacy `resolveModel` mock value, so route tests keep
 * their fixtures: `resolveParamsBinding: async (...a) =>
 * bindingFromLegacyResolved(await mocks.resolveModel(...a))`.
 */
export function bindingFromLegacyResolved(resolved: LegacyResolvedLike | undefined): ModelBinding {
  const value = resolved ?? {};
  const info = value.modelInfo ?? undefined;
  // Fixtures may hand a testBinding() as the legacy `model`; keep its identity fields.
  const bound = (value as { model?: Partial<ModelBinding> }).model;
  const fromBinding = typeof bound?.fingerprint === 'string' ? bound : undefined;
  const providerId = value.providerId ?? fromBinding?.providerId ?? 'openai';
  const modelId = value.modelId ?? fromBinding?.modelId ?? 'test-model';
  const base = testBinding();
  return testBinding({
    providerId,
    modelId,
    modelString: value.modelString ?? fromBinding?.modelString ?? `${providerId}:${modelId}`,
    ...(value.thinkingConfig ? { thinking: value.thinkingConfig } : {}),
    capabilities: {
      ...base.capabilities,
      knownModel: info?.outputWindow !== undefined,
      maxOutputTokens: info?.outputWindow,
      contextWindow: info?.contextWindow ?? base.capabilities.contextWindow,
      ...(info?.capabilities?.tools !== undefined ? { tools: info.capabilities.tools } : {}),
      ...(info?.capabilities?.vision !== undefined ? { vision: info.capabilities.vision } : {}),
    },
  });
}
