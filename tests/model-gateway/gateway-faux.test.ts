import { describe, expect, it } from 'vitest';
import {
  createFauxGateway,
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from '@/lib/model-gateway/testing/faux-gateway';
import { GatewayError, userText, withThinking } from '@/lib/model-gateway';
import type { GatewayStreamEvent } from '@/lib/model-gateway';

const request = { messages: [userText('Hello', 0)] };

async function collect(stream: AsyncIterable<GatewayStreamEvent>) {
  const events: GatewayStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('model gateway pipeline (faux provider)', () => {
  it('completes a text turn and records one usage event and one log line', async () => {
    const harness = createFauxGateway({ responses: [fauxAssistantMessage('Hi there')] });
    const result = await harness.gateway.complete(harness.binding(), request, { source: 'test' });

    expect(result.text).toBe('Hi there');
    expect(result.stopReason).toBe('stop');
    expect(result.attempts).toBe(1);
    expect(harness.usage).toHaveLength(1);
    expect(harness.usage[0]).toMatchObject({
      source: 'test',
      providerId: 'faux',
      modelString: 'faux:faux-model',
    });
    expect(harness.calls).toEqual([
      expect.objectContaining({ event: 'llm_call', status: 'ok', attempt: 1, funding: 'byok' }),
    ]);
  });

  it('streams pi events in order and ends with done; textStream yields only text', async () => {
    const harness = createFauxGateway({
      responses: [fauxAssistantMessage([fauxThinking('plan'), fauxText('answer')])],
    });
    const stream = harness.gateway.stream(harness.binding(), request, { source: 'test' });
    const events = await collect(stream);
    const types = events.map((event) => event.type);

    expect(types[0]).toBe('start');
    expect(types.at(-1)).toBe('done');
    expect(types).toContain('thinking_delta');
    expect(types.indexOf('thinking_start')).toBeLessThan(types.indexOf('text_start'));
    let text = '';
    for await (const delta of stream.textStream()) text += delta;
    expect(text).toBe('answer');
    expect((await stream.result()).reasoningText).toBe('plan');
  });

  it('keeps tool calls and thinking signatures in the final assistant message', async () => {
    const thinking = { ...fauxThinking('reason'), thinkingSignature: 'sig-123' };
    const harness = createFauxGateway({
      responses: [
        fauxAssistantMessage([thinking, fauxToolCall('lookup', { q: 'x' }, { id: 'call_1' })], {
          stopReason: 'toolUse',
        }),
      ],
    });
    const result = await harness.gateway.complete(harness.binding(), request, { source: 'test' });

    expect(result.stopReason).toBe('toolUse');
    expect(result.toolCalls).toEqual([
      expect.objectContaining({ id: 'call_1', name: 'lookup', arguments: { q: 'x' } }),
    ]);
    expect(result.message.content[0]).toMatchObject({
      type: 'thinking',
      thinkingSignature: 'sig-123',
    });
  });

  it('drops tool calls from a length-truncated turn', async () => {
    const harness = createFauxGateway({
      responses: [
        fauxAssistantMessage([fauxText('partial'), fauxToolCall('lookup', { q: 'x' })], {
          stopReason: 'length',
        }),
      ],
    });
    const result = await harness.gateway.complete(harness.binding(), request, { source: 'test' });
    expect(result.stopReason).toBe('length');
    expect(result.toolCalls).toEqual([]);
    expect(result.text).toBe('partial');
  });

  it('rejects result() with a GatewayError and ends iteration with an error event', async () => {
    const harness = createFauxGateway({
      responses: [
        fauxAssistantMessage([], {
          stopReason: 'error',
          errorMessage: '401 Unauthorized: bad key sk-secret',
        }),
      ],
    });
    const stream = harness.gateway.stream(harness.binding(), request, { source: 'test' });
    const events = await collect(stream);
    const terminal = events.at(-1)!;

    expect(terminal.type).toBe('error');
    if (terminal.type !== 'error') throw new Error('unreachable');
    expect(terminal.gatewayError).toBeInstanceOf(GatewayError);
    expect(terminal.gatewayError.code).toBe('MODEL_AUTH_FAILED');
    // Upstream text never leaks into the message consumers may persist.
    expect(terminal.error.errorMessage).not.toContain('sk-secret');
    await expect(stream.result()).rejects.toMatchObject({ code: 'MODEL_AUTH_FAILED' });
    expect(harness.calls).toHaveLength(1);
  });

  it('runs the revocation fence before every attempt and fails closed', async () => {
    const harness = createFauxGateway({ responses: [fauxAssistantMessage('never')] });
    let fenced = 0;
    await expect(
      harness.gateway.complete(harness.binding(), request, {
        source: 'test',
        beforeCall: async () => {
          fenced += 1;
          throw new GatewayError('MODEL_REAUTH_REQUIRED', { providerId: 'faux', modelId: 'm' });
        },
      }),
    ).rejects.toMatchObject({ code: 'MODEL_REAUTH_REQUIRED' });
    expect(fenced).toBe(1);
    expect(harness.faux.state.callCount).toBe(0);
  });

  it('retries validation failures in complete() and records every attempt', async () => {
    const harness = createFauxGateway({
      responses: [fauxAssistantMessage('bad'), fauxAssistantMessage('{"ok":true}')],
    });
    const result = await harness.gateway.complete(harness.binding(), request, {
      source: 'test',
      validate: (text) => text.startsWith('{'),
      validateRetries: 2,
    });
    expect(result.text).toBe('{"ok":true}');
    expect(result.attempts).toBe(2);
    expect(harness.usage).toHaveLength(2);
  });

  it('returns the last result when every validation attempt fails', async () => {
    const harness = createFauxGateway({
      responses: [fauxAssistantMessage('a'), fauxAssistantMessage('b')],
    });
    const result = await harness.gateway.complete(harness.binding(), request, {
      source: 'test',
      validate: () => false,
      validateRetries: 1,
    });
    expect(result.text).toBe('b');
    expect(harness.usage).toHaveLength(2);
  });

  describe('quota slot release', () => {
    it('releases after done', async () => {
      const harness = createFauxGateway({ quota: true, responses: [fauxAssistantMessage('ok')] });
      await harness.gateway.complete(harness.binding(), request, { source: 'test' });
      expect(harness.quota).toMatchObject({ acquired: 1, released: 1 });
    });

    it('releases after an upstream error and passes the error for cooldown', async () => {
      const harness = createFauxGateway({
        quota: true,
        responses: [
          fauxAssistantMessage([], { stopReason: 'error', errorMessage: '400 bad request' }),
        ],
      });
      await expect(
        harness.gateway.complete(harness.binding(), request, { source: 'test' }),
      ).rejects.toBeInstanceOf(GatewayError);
      expect(harness.quota).toMatchObject({ acquired: 1, released: 1 });
      expect(harness.quota.releaseErrors[0]).toBeInstanceOf(GatewayError);
    });

    it('releases after the caller aborts', async () => {
      const harness = createFauxGateway({
        quota: true,
        tokensPerSecond: 20,
        responses: [fauxAssistantMessage('a long answer that streams slowly '.repeat(20))],
      });
      const controller = new AbortController();
      const stream = harness.gateway.stream(harness.binding(), request, {
        source: 'test',
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 20);
      await expect(stream.result()).rejects.toMatchObject({ code: 'MODEL_ABORTED' });
      expect(harness.quota).toMatchObject({ acquired: 1, released: 1 });
    });

    it('releases when the consumer stops iterating', async () => {
      const harness = createFauxGateway({
        quota: true,
        tokensPerSecond: 20,
        responses: [fauxAssistantMessage('a long answer that streams slowly '.repeat(20))],
      });
      const stream = harness.gateway.stream(harness.binding(), request, { source: 'test' });
      for await (const event of stream) {
        if (event.type === 'text_delta') break;
      }
      await expect(stream.result()).rejects.toMatchObject({ code: 'MODEL_ABORTED' });
      expect(harness.quota).toMatchObject({ acquired: 1, released: 1 });
    });
  });

  it('authorizes and settles platform-funded calls only', async () => {
    const seen: string[] = [];
    const policy = {
      authorize: async () => {
        seen.push('authorize');
        return { id: 'grant' };
      },
      settle: async (_grant: unknown, outcome: { status: string }) => {
        seen.push(`settle:${outcome.status}`);
      },
    };
    const harness = createFauxGateway({
      responses: [fauxAssistantMessage('a'), fauxAssistantMessage('b')],
      deps: { entitlement: () => policy },
    });
    await harness.gateway.complete(
      harness.binding({
        source: 'platform',
        funding: { kind: 'platform', defaultId: 'zhiyu-default-text', revision: 'r1' },
      }),
      request,
      { source: 'test' },
    );
    await harness.gateway.complete(harness.binding(), request, { source: 'test' });
    expect(seen).toEqual(['authorize', 'settle:ok']);
  });

  it('denies a platform call when the entitlement policy refuses', async () => {
    const harness = createFauxGateway({
      responses: [fauxAssistantMessage('never')],
      deps: {
        entitlement: () => ({
          authorize: async () => {
            throw new GatewayError('MODEL_ENTITLEMENT_DENIED', {
              providerId: 'faux',
              modelId: 'm',
            });
          },
          settle: async () => undefined,
        }),
      },
    });
    await expect(
      harness.gateway.complete(
        harness.binding({
          funding: { kind: 'platform', defaultId: 'zhiyu-default-text', revision: 'r1' },
        }),
        request,
        { source: 'test' },
      ),
    ).rejects.toMatchObject({ code: 'MODEL_ENTITLEMENT_DENIED' });
    expect(harness.faux.state.callCount).toBe(0);
  });

  it('keeps credentials out of enumerable binding fields and JSON', () => {
    const harness = createFauxGateway();
    const binding = harness.binding();
    const json = JSON.stringify(binding);
    expect(json).not.toContain('faux-key');
    expect({ ...binding }).not.toHaveProperty('apiKey');
    expect(Object.isFrozen(binding)).toBe(true);
    expect(binding.credentialReady).toBe(true);
    const thinking = withThinking(binding, { mode: 'disabled' });
    expect(thinking.thinking).toEqual({ mode: 'disabled' });
    expect(binding.thinking).toBeUndefined();
  });

  it('drops images for non-vision models and reports a bad request for invalid tools', async () => {
    const harness = createFauxGateway({
      model: { id: 'text-only', input: ['text'] },
      responses: [
        (context) => {
          const user = context.messages.find((message) => message.role === 'user');
          return fauxAssistantMessage(JSON.stringify(user?.content));
        },
      ],
    });
    const result = await harness.gateway.complete(
      harness.binding(),
      {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'look' },
              { type: 'image', data: 'AAAA', mimeType: 'image/png' },
            ],
            timestamp: 0,
          },
        ],
      },
      { source: 'test' },
    );
    expect(result.text).not.toContain('image/png');

    await expect(
      harness.gateway.complete(
        harness.binding(),
        {
          ...request,
          tools: [{ name: 'bad name!', description: '', parameters: { type: 'object' } as never }],
        },
        { source: 'test' },
      ),
    ).rejects.toMatchObject({ code: 'MODEL_BAD_REQUEST' });
  });
});
