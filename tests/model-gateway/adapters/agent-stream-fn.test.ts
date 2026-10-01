/**
 * pi-agent-core 0.78 StreamFn over the gateway (plan 3.11), driven by a real
 * Agent against the faux gateway (a non-OpenAI protocol). Carries over the
 * legacy stream-fn guarantees and covers what the old pi → AI SDK → pi bridge
 * lost: signatures, user / tool-result images and real model ids.
 */
import type { AgentMessage, AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import { buildAgent } from '@/lib/agent/runtime/build-agent';
import {
  createGatewayStreamFn,
  hasLengthToolCallProvenance,
  toGatewayRequest,
} from '@/lib/model-gateway/adapters/agent-stream-fn';
import type { AgentAssistantMessage } from '@/lib/model-gateway/adapters/agent-pi-types';
import {
  createFauxGateway,
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type FauxResponseStep,
} from '@/lib/model-gateway/testing/faux-gateway';

const DemoParams = Type.Object({ value: Type.Number() });
const PNG = 'iVBORw0KGgo=';

type ToolContent = Array<
  { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
>;

function demoTool(
  content: ToolContent = [{ type: 'text', text: 'ok' }],
): AgentTool<typeof DemoParams> {
  return {
    name: 'demo',
    label: 'Demo',
    description: 'Test tool',
    parameters: DemoParams,
    execute: async () => ({ content, details: {} }),
  };
}

type Seen = { messages: Record<string, unknown>[]; maxTokens?: number };

/** A faux gateway whose responses also record the transcript each call saw. */
function scripted(steps: FauxResponseStep[], options: { vision?: boolean } = {}) {
  const seen: Seen[] = [];
  const faux = createFauxGateway({
    model: {
      id: 'faux-model',
      reasoning: true,
      input: options.vision === false ? ['text'] : ['text', 'image'],
    },
    responses: steps.map((step) => (context, streamOptions, state, model) => {
      seen.push({
        messages: context.messages as unknown as Record<string, unknown>[],
        maxTokens: streamOptions?.maxTokens,
      });
      return typeof step === 'function' ? step(context, streamOptions, state, model) : step;
    }),
  });
  return { faux, seen };
}

function agentFor(
  faux: ReturnType<typeof createFauxGateway>,
  options: {
    tools?: AgentTool<typeof DemoParams>[];
    history?: AgentMessage[];
    formatError?: (error: unknown) => string;
    beforeCall?: () => Promise<void>;
    omitMaxOutputTokens?: boolean;
    maxOutputTokens?: number;
  } = {},
) {
  const binding = faux.binding();
  return buildAgent({
    streamFn: createGatewayStreamFn({
      binding,
      gateway: faux.gateway,
      source: 'agent-test',
      formatError: options.formatError,
      beforeCall: options.beforeCall,
      omitMaxOutputTokens: options.omitMaxOutputTokens,
      maxOutputTokens: options.maxOutputTokens,
    }),
    systemPrompt: 'system',
    tools: options.tools ?? [demoTool()],
    allowedToolNames: new Set((options.tools ?? [demoTool()]).map((tool) => tool.name)),
    history: options.history,
  });
}

const assistants = (messages: AgentMessage[]) =>
  messages.filter((message): message is AgentAssistantMessage => message.role === 'assistant');

describe('agent StreamFn over the gateway', () => {
  it('runs two tool turns and replays the signed thinking on the same model', async () => {
    const { faux, seen } = scripted([
      fauxAssistantMessage(
        [
          { ...fauxThinking('plan the call'), thinkingSignature: 'sig-1' },
          fauxToolCall('demo', { value: 1 }, { id: 'call-1' }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(fauxText('done')),
    ]);
    const agent = agentFor(faux);
    await agent.prompt('go');

    expect(agent.state.errorMessage).toBeUndefined();
    expect(seen).toHaveLength(2);
    const replayed = seen[1]!.messages.find((message) => message.role === 'assistant') as {
      content: Record<string, unknown>[];
      provider: string;
    };
    // Real ids (not the legacy bridge's 'unknown') and the signature round-trip.
    expect(replayed.provider).not.toBe('unknown');
    expect(replayed.content).toContainEqual(
      expect.objectContaining({ type: 'thinking', thinkingSignature: 'sig-1' }),
    );
    expect(seen[1]!.messages).toContainEqual(
      expect.objectContaining({ role: 'toolResult', toolCallId: 'call-1' }),
    );
    const final = assistants(agent.state.messages).at(-1)!;
    expect(final.content).toEqual([expect.objectContaining({ type: 'text', text: 'done' })]);
    expect(faux.usage.map((event) => event.source)).toEqual(['agent-test', 'agent-test']);
  });

  it('strips thinking from legacy-bridge turns (provider "unknown") before sending', async () => {
    const { faux, seen } = scripted([fauxAssistantMessage(fauxText('ok'))]);
    const legacyTurn = {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'old private reasoning' },
        { type: 'text', text: 'old answer' },
      ],
      api: 'unknown',
      provider: 'unknown',
      model: 'maic-connector',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: 1,
    } as unknown as AgentMessage;
    const agent = agentFor(faux, {
      history: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 0 },
        legacyTurn,
      ],
    });
    await agent.prompt('continue');

    expect(agent.state.errorMessage).toBeUndefined();
    const sent = JSON.stringify(seen[0]!.messages);
    expect(sent).toContain('old answer');
    expect(sent).not.toContain('old private reasoning');
  });

  it('keeps user images and tool-result images for a vision model', async () => {
    const { faux, seen } = scripted([
      fauxAssistantMessage(fauxToolCall('demo', { value: 1 }, { id: 'call-1' }), {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage(fauxText('seen')),
    ]);
    const agent = agentFor(faux, {
      tools: [demoTool([{ type: 'image', data: PNG, mimeType: 'image/png' }])],
      history: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image', data: PNG, mimeType: 'image/png' },
          ],
          timestamp: 0,
        },
      ],
    });
    await agent.prompt('describe both');

    const second = JSON.stringify(seen[1]!.messages);
    // One image in the user turn, one in the tool result.
    expect(second.split(PNG).length - 1).toBe(2);
  });

  it('never executes the tool calls of a truncated (length) turn', async () => {
    const { faux } = scripted([
      fauxAssistantMessage(
        [fauxText('partial'), fauxToolCall('demo', { value: 1 }, { id: 'call-1' })],
        { stopReason: 'length' },
      ),
    ]);
    let executed = 0;
    const tool = demoTool();
    const counted: AgentTool<typeof DemoParams> = {
      ...tool,
      execute: async (...args) => {
        executed += 1;
        return tool.execute(...args);
      },
    };
    const agent = agentFor(faux, { tools: [counted] });
    await agent.prompt('go');

    expect(executed).toBe(0);
    const last = assistants(agent.state.messages).at(-1)!;
    expect(last.stopReason).toBe('length');
    expect(last.content.some((block) => block.type === 'toolCall')).toBe(false);
    expect(hasLengthToolCallProvenance(last)).toBe(true);
  });

  it('formats a terminal failure, and reports a revoked fence as itself', async () => {
    const failing = scripted([
      fauxAssistantMessage([], { stopReason: 'error', errorMessage: '401 key sk-secret rejected' }),
    ]);
    const agent = agentFor(failing.faux, {
      formatError: (error) => `formatted:${(error as { code?: string }).code ?? 'none'}`,
    });
    await agent.prompt('go');
    expect(assistants(agent.state.messages).at(-1)?.errorMessage).toBe(
      'formatted:MODEL_AUTH_FAILED',
    );
    expect(JSON.stringify(agent.state.messages)).not.toContain('sk-secret');

    const revoked = scripted([fauxAssistantMessage(fauxText('never'))]);
    const fenced = agentFor(revoked.faux, {
      beforeCall: async () => {
        throw new Error('PRO_MODEL_REVOKED');
      },
      formatError: (error) => (error instanceof Error ? error.message : String(error)),
    });
    await fenced.prompt('go');
    expect(revoked.seen).toHaveLength(0);
    expect(assistants(fenced.state.messages).at(-1)?.errorMessage).toBe('PRO_MODEL_REVOKED');
  });

  it('separates the wire output cap from the kernel compaction budget', () => {
    const context = { systemPrompt: 's', messages: [], tools: [] };
    // Unknown model: the kernel's reservation never becomes an API limit.
    expect(toGatewayRequest(context as never, 'omit').maxOutputTokens).toBe('omit');
    // Known model: the catalog cap, bounded by the kernel's request.
    expect(toGatewayRequest(context as never, 4_096).maxOutputTokens).toBe(4_096);
  });

  it('sends the smaller of the catalog cap and the kernel request, or omits it', async () => {
    const known = scripted([fauxAssistantMessage(fauxText('a'))]);
    await agentFor(known.faux, { maxOutputTokens: 4_096 }).prompt('go');
    expect(known.seen[0]!.maxTokens).toBeLessThanOrEqual(4_096);

    const unknown = scripted([fauxAssistantMessage(fauxText('b'))]);
    await agentFor(unknown.faux, { omitMaxOutputTokens: true }).prompt('go');
    expect(unknown.seen).toHaveLength(1);
  });
});
