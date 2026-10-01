/**
 * pi-agent-core 0.78 `StreamFn` over the gateway (plan 3.11). Replaces
 * lib/agent/runtime/stream-fn.ts, which converted pi → AI SDK → pi.
 *
 * The agent kernel hands us its 0.78 context (pi-shaped messages and typebox
 * tools); the gateway speaks pi 0.99. Both are the same JSON shapes, so the
 * conversion is structural — the two casts below are the only allowed ones
 * (plan 0.6) and tests/model-gateway/adapters/agent-stream-fn.test.ts checks
 * the runtime shapes.
 *
 * Kept from the legacy adapter: one gateway call per kernel turn, a `length`
 * turn never executes tool calls (with identity-only provenance for the
 * kernel's queue barrier), a single terminal event, the revocation fence
 * before every upstream attempt, and `formatError` / `omitMaxOutputTokens`.
 * New: user and tool-result images are no longer dropped (the gateway drops
 * them only for non-vision models), reasoning and signatures round-trip on
 * real api/provider/model ids, and DNS retries live in the gateway.
 */
import type { StreamFn } from '@earendil-works/pi-agent-core';
import {
  gateway as defaultGateway,
  type AssistantMessage,
  type GatewayCallOptions,
  type GatewayMessage,
  type GatewayRequest,
  type GatewayStreamEvent,
  type GatewayTool,
  type ModelBinding,
  type ModelGateway,
} from '@/lib/model-gateway';
import { toPiToolSchema } from '../runtime/pi-registry';
import type {
  AgentAssistantMessage,
  AgentAssistantMessageEvent,
  AgentLlmContext,
  AgentLlmTool,
  AgentStreamOptions,
} from './agent-pi-types';
import { loadAgentLegacyPi } from './agent-legacy-pi';

export interface GatewayStreamFnOptions {
  binding: ModelBinding;
  /** Stage / purpose label for usage and logs. */
  source: string;
  /** Run-scoped credential revocation fence before every upstream attempt. */
  beforeCall?: () => Promise<void>;
  /** Maps the terminal failure to the message the kernel records. */
  formatError?: (error: unknown) => string;
  abortSignal?: AbortSignal;
  /** Upper bound for the wire output cap (combined with the kernel's request). */
  maxOutputTokens?: number;
  /**
   * Never send an output cap, even when the kernel supplies `maxTokens`: its
   * per-call budget is an internal compaction estimate, not an API limit.
   */
  omitMaxOutputTokens?: boolean;
  retry?: GatewayCallOptions['retry'];
  /** Test seam; production uses the process gateway. */
  gateway?: ModelGateway;
}

const lengthToolCallMessages = new WeakSet<object>();

/**
 * Identity-only provenance for the one terminal condition that needs the
 * shared Agent queue barrier: a `length` turn whose tool calls were removed.
 * Deliberately not a message field or serializable metadata.
 */
export function hasLengthToolCallProvenance(message: AgentAssistantMessage): boolean {
  return lengthToolCallMessages.has(message);
}

/**
 * Turns the legacy bridge wrote with `provider: 'unknown'` carry thinking that
 * was never meant to be replayed; pi would turn it into cross-provider text.
 */
function stripLegacyBridgeThinking(message: GatewayMessage): GatewayMessage {
  if (message.role !== 'assistant' || message.provider !== 'unknown') return message;
  return { ...message, content: message.content.filter((block) => block.type !== 'thinking') };
}

const toolSchemas = new WeakMap<object, GatewayTool['parameters']>();

/** typebox 0.x schema → plain JSON Schema adopted as a pi 0.99 tool schema. */
function toGatewayTool(tool: AgentLlmTool): GatewayTool {
  let parameters = toolSchemas.get(tool.parameters);
  if (!parameters) {
    parameters = toPiToolSchema(JSON.parse(JSON.stringify(tool.parameters)));
    toolSchemas.set(tool.parameters, parameters);
  }
  return { name: tool.name, description: tool.description, parameters };
}

export function toGatewayRequest(
  context: AgentLlmContext,
  maxOutputTokens: GatewayRequest['maxOutputTokens'],
): GatewayRequest {
  // Allowed cast 1/2: 0.78 messages are the same JSON shapes as 0.99 messages.
  const messages = (context.messages as unknown as GatewayMessage[]).map(stripLegacyBridgeThinking);
  return {
    ...(context.systemPrompt ? { system: context.systemPrompt } : {}),
    messages,
    ...(context.tools?.length
      ? { tools: context.tools.map(toGatewayTool), toolChoice: 'auto' as const }
      : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
  };
}

function wireMaxOutputTokens(
  opts: GatewayStreamFnOptions,
  requested: number | undefined,
): GatewayRequest['maxOutputTokens'] {
  if (opts.omitMaxOutputTokens) return 'omit';
  if (opts.maxOutputTokens && requested) return Math.min(opts.maxOutputTokens, requested);
  return requested ?? opts.maxOutputTokens;
}

function combineSignals(signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (present.length <= 1) return present[0];
  return AbortSignal.any(present);
}

function withoutToolCalls(message: AssistantMessage): AssistantMessage {
  return { ...message, content: message.content.filter((block) => block.type !== 'toolCall') };
}

export function createGatewayStreamFn(opts: GatewayStreamFnOptions): StreamFn {
  const gateway = opts.gateway ?? defaultGateway;
  return (async (_model: unknown, context: AgentLlmContext, options?: AgentStreamOptions) => {
    const legacyPi = await loadAgentLegacyPi();
    const out = legacyPi.createAssistantMessageEventStream();
    // Allowed cast 2/2: 0.99 events / messages are structurally the 0.78 ones.
    const push = (event: GatewayStreamEvent | AgentAssistantMessageEvent) =>
      out.push(event as unknown as AgentAssistantMessageEvent);

    // A fence failure (revoked connection) is reported as itself, not as the
    // generic classification the gateway gives a non-transport error.
    let fenceError: unknown;
    const beforeCall = opts.beforeCall
      ? async () => {
          try {
            await opts.beforeCall!();
          } catch (error) {
            fenceError = error;
            throw error;
          }
        }
      : undefined;

    const stream = gateway.stream(
      opts.binding,
      toGatewayRequest(context, wireMaxOutputTokens(opts, options?.maxTokens)),
      {
        source: opts.source,
        ...(beforeCall ? { beforeCall } : {}),
        ...(opts.retry ? { retry: opts.retry } : {}),
        signal: combineSignals([opts.abortSignal, options?.signal]),
        ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
      },
    );

    void (async () => {
      let sawToolCall = false;
      for await (const event of stream) {
        if (event.type === 'toolcall_end') sawToolCall = true;
        if (event.type === 'done') {
          if (event.reason === 'length') {
            // Never execute a truncated turn's tool calls.
            const message = withoutToolCalls(event.message);
            if (sawToolCall) lengthToolCallMessages.add(message);
            push({ ...event, message });
          } else {
            push(event);
          }
          return;
        }
        if (event.type === 'error') {
          const cause = fenceError ?? event.gatewayError;
          const errorMessage = opts.formatError
            ? opts.formatError(cause)
            : event.gatewayError.message;
          push({
            type: 'error',
            reason: event.reason,
            error: { ...withoutToolCalls(event.error), stopReason: event.reason, errorMessage },
          } as unknown as AgentAssistantMessageEvent);
          return;
        }
        push(event);
      }
    })();

    return out;
  }) as StreamFn;
}
