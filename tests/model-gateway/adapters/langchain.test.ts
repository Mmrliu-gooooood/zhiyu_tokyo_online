import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { GatewayLangGraphAdapter } from '@/lib/model-gateway/adapters/langchain';
import { createFauxGateway, fauxAssistantMessage } from '@/lib/model-gateway/testing/faux-gateway';

describe('GatewayLangGraphAdapter', () => {
  it('maps LangChain messages and returns the completion as an AIMessage', async () => {
    let seen: { system: string; roles: string[] } | undefined;
    const faux = createFauxGateway({
      responses: [
        (context) => {
          // pi carries the prompt as leading system messages of the transcript.
          seen = {
            system: JSON.stringify(context.messages.filter((m) => m.role === 'system')),
            roles: context.messages.filter((m) => m.role !== 'system').map((m) => m.role),
          };
          return fauxAssistantMessage('Hello there');
        },
      ],
    });
    const adapter = new GatewayLangGraphAdapter(faux.binding(), faux.gateway);

    const result = await adapter._generate([
      new SystemMessage('You are the director.'),
      new HumanMessage('hi'),
      new AIMessage('earlier reply'),
      new HumanMessage('again'),
    ]);

    expect(result.generations[0]?.text).toBe('Hello there');
    expect(result.generations[0]?.message).toBeInstanceOf(AIMessage);
    expect(seen?.system).toContain('You are the director.');
    expect(seen?.roles).toEqual(['user', 'assistant', 'user']);
    expect(faux.usage).toEqual([expect.objectContaining({ source: 'chat-adapter' })]);
  });

  it('streams deltas then the full content', async () => {
    const faux = createFauxGateway({ responses: [fauxAssistantMessage('streamed answer')] });
    const adapter = new GatewayLangGraphAdapter(faux.binding(), faux.gateway);

    const chunks = [];
    for await (const chunk of adapter.streamGenerate([new HumanMessage('hi')])) chunks.push(chunk);

    const deltas = chunks.filter((chunk) => chunk.type === 'delta');
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.map((chunk) => (chunk as { content: string }).content).join('')).toBe(
      'streamed answer',
    );
    expect(chunks.at(-1)).toEqual({ type: 'done', content: 'streamed answer' });
    expect(faux.usage).toEqual([expect.objectContaining({ source: 'chat-adapter-stream' })]);
  });

  it('throws the classified gateway error when the stream fails', async () => {
    const faux = createFauxGateway({
      responses: [fauxAssistantMessage([], { stopReason: 'error', errorMessage: '400 bad' })],
    });
    const adapter = new GatewayLangGraphAdapter(faux.binding(), faux.gateway);

    const consume = async () => {
      for await (const _chunk of adapter.streamGenerate([new HumanMessage('hi')])) {
        // drain
      }
    };
    await expect(consume()).rejects.toMatchObject({ name: 'GatewayError' });
  });
});
