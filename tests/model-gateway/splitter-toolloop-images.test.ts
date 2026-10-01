import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createFauxGateway,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from '@/lib/model-gateway/testing/faux-gateway';
import { runToolLoop, userContent, userText } from '@/lib/model-gateway';
import { splitInlineThinkTags } from '@/lib/model-gateway/runtime/think-tag-splitter';
import { resolveImages } from '@/lib/model-gateway/runtime/images';
import type { AssistantMessage, AssistantMessageEvent, ToolLoopEvent } from '@/lib/model-gateway';

function sourceEvents(deltas: string[]): AssistantMessageEvent[] {
  const partial: AssistantMessage = {
    role: 'assistant',
    content: [{ type: 'text', text: '' }],
    api: 'test',
    provider: 'test',
    model: 'test',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 0,
  };
  const text = deltas.join('');
  return [
    { type: 'start', partial },
    { type: 'text_start', contentIndex: 0, partial },
    ...deltas.map((delta) => ({ type: 'text_delta' as const, contentIndex: 0, delta, partial })),
    { type: 'text_end', contentIndex: 0, content: text, partial },
    { type: 'done', reason: 'stop', message: { ...partial, content: [{ type: 'text', text }] } },
  ];
}

async function split(deltas: string[]) {
  async function* source() {
    yield* sourceEvents(deltas);
  }
  const out: AssistantMessageEvent[] = [];
  for await (const event of splitInlineThinkTags(source())) out.push(event);
  const done = out.at(-1);
  if (done?.type !== 'done') throw new Error('no done');
  return { events: out, content: done.message.content };
}

describe('inline <think> splitter', () => {
  it('splits a think block into a thinking block followed by clean text', async () => {
    const { content } = await split(['<think>plan it</think>\n\nThe answer.']);
    expect(content).toEqual([
      { type: 'thinking', thinking: 'plan it' },
      { type: 'text', text: 'The answer.' },
    ]);
  });

  it('handles tags split across deltas', async () => {
    const { content, events } = await split(['<thi', 'nk>step', ' one</th', 'ink>Done']);
    expect(content).toEqual([
      { type: 'thinking', thinking: 'step one' },
      { type: 'text', text: 'Done' },
    ]);
    const indexes = events
      .filter((e) => 'contentIndex' in e)
      .map((e) => (e as { contentIndex: number }).contentIndex);
    expect(Math.max(...indexes)).toBe(1);
  });

  it('passes plain text through and keeps an unterminated think block as thinking', async () => {
    expect((await split(['hello ', 'world'])).content).toEqual([
      { type: 'text', text: 'hello world' },
    ]);
    expect((await split(['<think>still thinking'])).content).toEqual([
      { type: 'thinking', thinking: 'still thinking' },
    ]);
  });

  it('is applied by the gateway when the binding enables it', async () => {
    const harness = createFauxGateway({
      responses: [fauxAssistantMessage('<think>why</think>Because.')],
    });
    const result = await harness.gateway.complete(
      harness.binding({ transforms: { inlineThinkTags: true, payloadPatches: [] } }),
      { messages: [userText('q', 0)] },
      { source: 'test' },
    );
    expect(result.text).toBe('Because.');
    expect(result.reasoningText).toBe('why');
  });
});

describe('runToolLoop', () => {
  const lookup = {
    name: 'lookup',
    description: 'Look something up',
    inputSchema: z.object({ query: z.string() }),
  };

  it('runs tools once each, feeds results back, and finishes on a text turn', async () => {
    const executed: string[] = [];
    const harness = createFauxGateway({
      responses: [
        fauxAssistantMessage(
          [
            fauxToolCall('lookup', { query: 'a' }, { id: 't1' }),
            fauxToolCall('lookup', { query: 'b' }, { id: 't2' }),
          ],
          { stopReason: 'toolUse' },
        ),
        (context) => {
          const results = context.messages.filter((message) => message.role === 'toolResult');
          return fauxAssistantMessage(`saw ${results.length} results`);
        },
      ],
    });
    const steps: number[] = [];
    const loop = runToolLoop(
      harness.gateway,
      harness.binding(),
      {
        messages: [userText('go', 0)],
        tools: [
          {
            ...lookup,
            execute: async ({ query }: { query: string }) => {
              executed.push(query);
              return { answer: query.toUpperCase() };
            },
          },
        ],
        maxSteps: 5,
        onStepFinish: (step) => {
          steps.push(step.index);
        },
      },
      { source: 'loop-test' },
    );
    const order: string[] = [];
    for await (const event of loop) {
      if (event.type === 'tool_result' || event.type === 'step_finish') order.push(event.type);
    }
    const result = await loop.result();

    expect(executed).toEqual(['a', 'b']);
    expect(order).toEqual(['tool_result', 'tool_result', 'step_finish', 'step_finish']);
    expect(steps).toEqual([0, 1]);
    expect(result.text).toBe('saw 2 results');
    expect(result.finishReason).toBe('stop');
    expect(harness.usage).toHaveLength(2);
  });

  it('turns invalid tool input into an error result the model sees', async () => {
    let executed = 0;
    const harness = createFauxGateway({
      responses: [
        fauxAssistantMessage(fauxToolCall('lookup', { query: 42 }), { stopReason: 'toolUse' }),
        fauxAssistantMessage('recovered'),
      ],
    });
    const events: ToolLoopEvent[] = [];
    const loop = runToolLoop(
      harness.gateway,
      harness.binding(),
      {
        messages: [userText('go', 0)],
        tools: [
          {
            ...lookup,
            execute: () => {
              executed += 1;
              return 'never';
            },
          },
        ],
        maxSteps: 3,
      },
      { source: 'loop-test' },
    );
    for await (const event of loop) events.push(event);
    const toolResult = events.find((event) => event.type === 'tool_result');
    expect(toolResult).toMatchObject({ isError: true });
    expect(executed).toBe(0);
    expect((await loop.result()).text).toBe('recovered');
  });

  it('stops on a stopWhen predicate and on maxSteps', async () => {
    const call = () =>
      fauxAssistantMessage(fauxToolCall('lookup', { query: 'x' }), { stopReason: 'toolUse' });
    const harness = createFauxGateway({ responses: [call(), call(), call()] });
    const tools = [{ ...lookup, execute: () => 'ok' }];
    const byPredicate = await runToolLoop(
      harness.gateway,
      harness.binding(),
      { messages: [userText('go', 0)], tools, maxSteps: 5, stopWhen: (step) => step.index === 0 },
      { source: 'loop-test' },
    ).result();
    expect(byPredicate.finishReason).toBe('stop-condition');
    expect(byPredicate.steps).toHaveLength(1);

    const byLimit = await runToolLoop(
      harness.gateway,
      harness.binding(),
      { messages: [userText('go', 0)], tools, maxSteps: 2 },
      { source: 'loop-test' },
    ).result();
    expect(byLimit.finishReason).toBe('max-steps');
    expect(byLimit.steps).toHaveLength(2);
  });

  it('declares zod schemas as JSON Schema tool parameters', async () => {
    const harness = createFauxGateway({
      responses: [
        (context) => {
          const system = context.messages.find((message) => message.role === 'system');
          const tools = system && 'toolsAdded' in system ? system.toolsAdded : [];
          return fauxAssistantMessage(fauxText(JSON.stringify(tools?.[0]?.parameters)));
        },
      ],
    });
    const result = await runToolLoop(
      harness.gateway,
      harness.binding(),
      { messages: [userText('go', 0)], tools: [{ ...lookup, execute: () => 'ok' }], maxSteps: 1 },
      { source: 'loop-test' },
    ).result();
    expect(JSON.parse(result.text)).toMatchObject({
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    });
  });
});

describe('image inputs', () => {
  it('decodes data URIs locally and fetches URLs through the guarded downloader', async () => {
    const fetched: string[] = [];
    const message = userContent(
      'look',
      ['data:image/png;base64,AAAA', 'https://images.example/cat.png'],
      0,
    );
    const { messages } = await resolveImages([message], {
      vision: true,
      fetchImage: async (url) => {
        fetched.push(url);
        return { type: 'image', data: 'BBBB', mimeType: 'image/jpeg' };
      },
    });
    expect(fetched).toEqual(['https://images.example/cat.png']);
    expect(messages[0]).toMatchObject({
      content: [
        { type: 'text', text: 'look' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        { type: 'image', data: 'BBBB', mimeType: 'image/jpeg' },
      ],
    });
  });

  it('refuses private image URLs', async () => {
    await expect(
      resolveImages([userContent('look', ['http://127.0.0.1/secret.png'], 0)], { vision: true }),
    ).rejects.toThrow();
  });
});
