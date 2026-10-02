import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PROVIDERS } from '@/lib/model-gateway/catalog/client-catalog';
import {
  startFakeModelServer,
  type FakeModelServer,
} from '@/lib/model-gateway/testing/fake-openai-server';
import { runToolLoop, userText, type GatewayMessage } from '@/lib/model-gateway';
import type { PiModel } from '@/lib/model-gateway/types';
import { equivalenceBinding } from './characterization/thinking-equivalence';
import { testGateway } from './helpers';

let server: FakeModelServer;
beforeAll(async () => {
  server = await startFakeModelServer();
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => server.reset());

function glmBinding() {
  const info = PROVIDERS.glm.models.find((model) => model.id === 'glm-5.2');
  const model = {
    reasoning: true,
    id: 'glm-5.2',
    name: 'GLM-5.2',
    api: 'openai-completions',
    provider: 'glm',
    baseUrl: '',
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
    // Explicit, as the P2 GLM descriptor must be: pi only auto-detects GLM from
    // the official hosts, and a relay URL would otherwise get `developer` roles.
    compat: {
      thinkingFormat: 'zai',
      supportsReasoningEffort: false,
      supportsDeveloperRole: false,
      supportsStore: false,
      maxTokensField: 'max_tokens',
    },
  } as PiModel;
  return equivalenceBinding(
    {
      model,
      upstream: 'custom',
      capability: info?.capabilities?.thinking,
      thinking: { enabled: true },
      knownModel: true,
    },
    server.origin,
  );
}

interface ChatBody {
  thinking?: Record<string, unknown>;
  messages: { role: string; content?: unknown; tool_call_id?: string; tool_calls?: unknown[] }[];
}

const bodyAt = (index: number) => server.requests[index]?.body as ChatBody;
const contentText = (content: unknown) =>
  typeof content === 'string' ? content : JSON.stringify(content ?? '');

describe('GLM multi-turn session (thinking on)', () => {
  it('keeps the whole conversation across turns and never sends clear_thinking', async () => {
    let turn = 0;
    server.setHandler(() => {
      turn += 1;
      return { kind: 'auto', reasoning: `thought ${turn}`, text: `answer ${turn}` };
    });
    const { gateway } = testGateway();
    const binding = glmBinding();
    const messages: GatewayMessage[] = [];
    for (const [index, question] of ['first', 'second', 'third'].entries()) {
      messages.push(userText(question, index));
      const result = await gateway.complete(
        binding,
        { system: 'tutor', messages },
        { source: 'multi-turn-test' },
      );
      expect(result.text).toBe(`answer ${index + 1}`);
      expect(result.reasoningText).toBe(`thought ${index + 1}`);
      messages.push(result.message);
    }

    expect(server.requests).toHaveLength(3);
    for (let index = 0; index < 3; index += 1) {
      const body = bodyAt(index);
      expect(body.thinking).toEqual({ type: 'enabled' });
      // system + (user, assistant) * index + user
      expect(body.messages).toHaveLength(2 + index * 2);
    }
    const last = bodyAt(2).messages;
    expect(
      last.filter((message) => message.role === 'user').map((m) => contentText(m.content)),
    ).toEqual([
      expect.stringContaining('first'),
      expect.stringContaining('second'),
      expect.stringContaining('third'),
    ]);
    expect(
      last.filter((message) => message.role === 'assistant').map((m) => contentText(m.content)),
    ).toEqual([expect.stringContaining('answer 1'), expect.stringContaining('answer 2')]);
  });

  it('runs a tool loop inside a turn and continues the session afterwards', async () => {
    let turn = 0;
    server.setHandler(() => {
      turn += 1;
      if (turn === 1)
        return {
          kind: 'auto',
          reasoning: 'need a lookup',
          toolCalls: [{ id: 'call_1', name: 'lookup', arguments: { query: 'pi' } }],
        };
      return { kind: 'auto', reasoning: `thought ${turn}`, text: `answer ${turn}` };
    });
    const { gateway } = testGateway();
    const binding = glmBinding();
    const loop = runToolLoop(
      gateway,
      binding,
      {
        system: 'tutor',
        messages: [userText('what is pi?', 0)],
        tools: [
          {
            name: 'lookup',
            description: 'Look something up',
            inputSchema: z.object({ query: z.string() }),
            execute: ({ query }: { query: string }) => ({ value: `${query}=3.14159` }),
          },
        ],
        maxSteps: 4,
      },
      { source: 'multi-turn-test' },
    );
    const looped = await loop.result();
    expect(looped.text).toBe('answer 2');

    const followUp = await gateway.complete(
      binding,
      { system: 'tutor', messages: [...looped.messages, userText('and twice that?', 1)] },
      { source: 'multi-turn-test' },
    );
    expect(followUp.text).toBe('answer 3');

    expect(server.requests).toHaveLength(3);
    for (let index = 0; index < 3; index += 1) {
      expect(bodyAt(index).thinking).toEqual({ type: 'enabled' });
    }
    const toolRound = bodyAt(1).messages;
    expect(toolRound.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
    ]);
    expect(toolRound[2]?.tool_calls).toHaveLength(1);
    expect(toolRound[3]?.tool_call_id).toBe('call_1');
    expect(contentText(toolRound[3]?.content)).toContain('3.14159');
    expect(bodyAt(2).messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'assistant',
      'user',
    ]);
  });
});
