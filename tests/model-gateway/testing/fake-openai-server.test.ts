/**
 * Self-test for the fake model server: the real pi-ai 0.99 protocol clients
 * must parse its OpenAI Chat, OpenAI Responses and Anthropic Messages output
 * (text, reasoning, tool calls, usage) and see its scripted failures.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createModels, type Api, type Context, type Model } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import {
  startFakeModelServer,
  type FakeModelServer,
} from '@/lib/model-gateway/testing/fake-openai-server';

let server: FakeModelServer;
const models = createModels();
models.setProvider(deepseekProvider());
models.setProvider(openaiProvider());
models.setProvider(anthropicProvider());

function at(provider: string, id: string, path = ''): Model<Api> {
  const model = models.getModel(provider, id);
  if (!model) throw new Error(`pi catalog has no ${provider}/${id}`);
  return { ...model, baseUrl: `${server.origin}${path}` };
}

const context: Context = {
  systemPrompt: 'You are a test.',
  messages: [{ role: 'user', content: 'Hello', timestamp: 0 }],
  tools: [
    {
      name: 'lookup',
      description: 'Look up a fact.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      } as never,
    },
  ],
};

const protocols = [
  { name: 'openai-completions', model: () => at('deepseek', 'deepseek-flash') },
  { name: 'openai-responses', model: () => at('openai', 'gpt-5.4', '/v1') },
  { name: 'anthropic-messages', model: () => at('anthropic', 'claude-sonnet-4-5') },
];

beforeAll(async () => {
  server = await startFakeModelServer();
});
beforeEach(() => server.reset());
afterAll(async () => {
  await server.close();
});

describe('fake model server', () => {
  for (const protocol of protocols) {
    it(`${protocol.name}: streams text, reasoning, tool calls and usage`, async () => {
      server.setHandler(() => ({
        kind: 'auto',
        reasoning: 'thinking it over',
        text: 'Hello there',
        textChunks: 3,
        toolCalls: [{ id: 'call_1', name: 'lookup', arguments: { query: 'x' } }],
        usage: { input: 12, output: 7, cacheRead: 3 },
      }));
      const message = await models.completeSimple(protocol.model(), context, {
        apiKey: 'sk-fake',
        reasoning: 'high',
        maxRetries: 0,
      });

      expect(message.errorMessage).toBeUndefined();
      expect(message.stopReason).toBe('toolUse');
      const text = message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      expect(text).toBe('Hello there');
      expect(message.content.some((block) => block.type === 'thinking')).toBe(true);
      expect(message.content).toContainEqual(
        expect.objectContaining({ type: 'toolCall', name: 'lookup', arguments: { query: 'x' } }),
      );
      expect(message.usage.input).toBe(12);
      expect(message.usage.cacheRead).toBe(3);
      expect(message.usage.output).toBe(7);
      expect(server.requests).toHaveLength(1);
      expect((server.requests[0].body as { stream?: boolean }).stream).toBe(true);
    });

    it(`${protocol.name}: surfaces 429 with retry-after as an error`, async () => {
      server.setHandler(() => ({ kind: 'error', status: 429, headers: { 'retry-after': '2' } }));
      const message = await models.completeSimple(protocol.model(), context, {
        apiKey: 'sk-fake',
        maxRetries: 0,
      });
      expect(message.stopReason).toBe('error');
      expect(server.requests).toHaveLength(1);
    });

    it(`${protocol.name}: a mid-stream disconnect ends in an error`, async () => {
      server.setHandler(() => ({
        kind: 'auto',
        text: 'partial output that never finishes',
        textChunks: 6,
        disconnectAfterEvents: 3,
      }));
      const message = await models.completeSimple(protocol.model(), context, {
        apiKey: 'sk-fake',
        maxRetries: 0,
      });
      expect(message.stopReason).toBe('error');
    });
  }

  it('records request headers and honours first-byte delay', async () => {
    server.setHandler(() => ({ kind: 'auto', text: 'late', firstByteDelayMs: 50 }));
    const started = Date.now();
    const message = await models.completeSimple(at('deepseek', 'deepseek-flash'), context, {
      apiKey: 'sk-fake',
      maxRetries: 0,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    expect(message.stopReason).toBe('stop');
    expect(server.requests[0].headers.authorization).toBe('Bearer sk-fake');
    expect(server.requests[0].path).toBe('/chat/completions');
  });
});
