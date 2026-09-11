import type { AssistantMessageEvent, SimpleStreamOptions } from '@earendil-works/pi-ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ streamLLM: vi.fn() }));

vi.mock('@/lib/ai/llm', () => ({ streamLLM: mocks.streamLLM }));

import { createCallLlmStreamFn, hasLengthToolCallProvenance } from '@/lib/agent/runtime/stream-fn';

const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
};

function finish(finishReason: unknown) {
  return { type: 'finish', finishReason, totalUsage: ZERO_USAGE };
}

function toolCall() {
  return {
    type: 'tool-call',
    toolCallId: 'call-1',
    toolName: 'demo',
    input: { value: 1 },
  };
}

function resultFrom(parts: Array<Record<string, unknown>>) {
  return {
    fullStream: (async function* () {
      for (const part of parts) yield part;
    })(),
    usage: new Promise(() => {}),
  };
}

async function collect(
  parts: Array<Record<string, unknown>>,
  options: { outerSignal?: AbortSignal; streamOptions?: SimpleStreamOptions } = {},
) {
  mocks.streamLLM.mockReturnValue(resultFrom(parts));
  const streamFn = createCallLlmStreamFn({
    languageModel: {} as never,
    abortSignal: options.outerSignal,
  });
  const stream = await streamFn(
    {} as never,
    { systemPrompt: 'system', messages: [], tools: [] },
    options.streamOptions,
  );
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return { events, message: await stream.result() };
}

describe('createCallLlmStreamFn terminal contract', () => {
  beforeEach(() => mocks.streamLLM.mockReset());

  it.each([
    { name: 'plain stop', reason: 'stop', withTool: false, stopReason: 'stop', event: 'done' },
    {
      name: 'stop upgraded by a parsed tool call',
      reason: 'stop',
      withTool: true,
      stopReason: 'toolUse',
      event: 'done',
    },
    {
      name: 'tool-calls with a parsed tool call',
      reason: 'tool-calls',
      withTool: true,
      stopReason: 'toolUse',
      event: 'done',
    },
    {
      name: 'tool-calls without a parsed tool call',
      reason: 'tool-calls',
      withTool: false,
      stopReason: 'error',
      event: 'error',
    },
    {
      name: 'plain length',
      reason: 'length',
      withTool: false,
      stopReason: 'length',
      event: 'done',
    },
    {
      name: 'length with a parsed tool call',
      reason: 'length',
      withTool: true,
      stopReason: 'length',
      event: 'done',
    },
    {
      name: 'content filter',
      reason: 'content-filter',
      withTool: true,
      stopReason: 'error',
      event: 'error',
    },
    {
      name: 'provider error finish',
      reason: 'error',
      withTool: true,
      stopReason: 'error',
      event: 'error',
    },
    {
      name: 'other finish',
      reason: 'other',
      withTool: true,
      stopReason: 'error',
      event: 'error',
    },
    {
      name: 'malformed finish',
      reason: 'future-reason',
      withTool: true,
      stopReason: 'error',
      event: 'error',
    },
  ])('$name maps deterministically', async ({ reason, withTool, stopReason, event }) => {
    const parts = [
      { type: 'text-delta', text: 'visible' },
      ...(withTool ? [toolCall()] : []),
      finish(reason),
    ];

    const { events, message } = await collect(parts);
    const terminal = events.filter(
      (candidate) => candidate.type === 'done' || candidate.type === 'error',
    );

    expect(events[0]?.type).toBe('start');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.type).toBe(event);
    if (terminal[0]?.type === 'done') expect(terminal[0].message).toBe(message);
    if (terminal[0]?.type === 'error') expect(terminal[0].error).toBe(message);
    expect(message.stopReason).toBe(stopReason);
    if (event === 'error') expect(message.errorMessage?.length).toBeGreaterThan(0);

    const finalToolCalls = message.content.filter((content) => content.type === 'toolCall');
    const toolCallsRemain = stopReason === 'toolUse';
    expect(finalToolCalls).toHaveLength(toolCallsRemain ? 1 : 0);
    expect(hasLengthToolCallProvenance(message)).toBe(reason === 'length' && withTool);
  });

  it('uses only the top-level finish part as finish authority', async () => {
    const { message } = await collect([
      { type: 'finish-step', finishReason: 'length' },
      { type: 'text-delta', text: 'answer' },
      finish('stop'),
    ]);

    expect(message.stopReason).toBe('stop');
  });

  it('fails closed when fullStream ends without a terminal part', async () => {
    const { events, message } = await collect([{ type: 'text-delta', text: 'partial' }]);

    expect(events.at(-1)?.type).toBe('error');
    expect(message.stopReason).toBe('error');
    expect(message.errorMessage).toContain('without a terminal event');
  });

  it('maps top-level abort and error parts to the Pi error channel', async () => {
    const aborted = await collect([{ type: 'abort', reason: 'provider cancelled' }]);
    const failed = await collect([{ type: 'error', error: new Error('provider failed') }]);

    expect(aborted.message).toMatchObject({
      stopReason: 'aborted',
      errorMessage: 'provider cancelled',
    });
    expect(aborted.events.at(-1)).toMatchObject({ type: 'error', reason: 'aborted' });
    expect(failed.message).toMatchObject({ stopReason: 'error', errorMessage: 'provider failed' });
    expect(failed.events.at(-1)).toMatchObject({ type: 'error', reason: 'error' });
  });

  it('returns a protocol stream when provider stream setup fails', async () => {
    mocks.streamLLM.mockReturnValue({
      fullStream: (async function* () {
        throw new Error('request setup failed');
      })(),
      usage: new Promise(() => {}),
    });
    const streamFn = createCallLlmStreamFn({ languageModel: {} as never });

    let returned: ReturnType<typeof streamFn> | undefined;
    expect(() => {
      returned = streamFn({} as never, { systemPrompt: 'system', messages: [], tools: [] }, {});
    }).not.toThrow();
    const stream = await returned!;
    const events: AssistantMessageEvent[] = [];
    for await (const event of stream) events.push(event);

    // Keep the result assertion separate from stream iteration so a request
    // setup exception can only be observed through the Pi protocol.
    const finalMessage = await stream.result();

    expect(events.map((event) => event.type)).toEqual(['start', 'error']);
    expect(finalMessage).toMatchObject({
      stopReason: 'error',
      errorMessage: 'request setup failed',
    });
  });

  it.each(['EAI_AGAIN', 'ENOTFOUND'] as const)(
    'retries a pre-send %s failure twice inside one agent turn',
    async (code) => {
      let calls = 0;
      mocks.streamLLM.mockImplementation(() => {
        calls += 1;
        return resultFrom(
          calls < 3
            ? [{ type: 'error', error: Object.assign(new Error('dns'), { code }) }]
            : [{ type: 'text-delta', text: 'recovered' }, finish('stop')],
        );
      });
      const beforeCall = vi.fn().mockResolvedValue(undefined);
      const streamFn = createCallLlmStreamFn({
        languageModel: {} as never,
        beforeCall,
        retryPreSendDns: true,
        dnsRetryDelaysMs: [0, 0],
        dnsDiagnostic: {
          providerId: 'deepseek',
          hostname: 'api.deepseek.com',
          step: 'maic-agent-driver',
        },
      });

      const stream = await streamFn({} as never, {
        systemPrompt: 'system',
        messages: [],
        tools: [],
      });
      for await (const _event of stream) {
        // drain
      }

      expect(calls).toBe(3);
      expect(beforeCall).toHaveBeenCalledTimes(3);
      await expect(stream.result()).resolves.toMatchObject({
        stopReason: 'stop',
        content: [{ type: 'text', text: 'recovered' }],
      });
    },
  );

  it('does not retry DNS-shaped errors after provider output has started', async () => {
    mocks.streamLLM.mockReturnValue(
      resultFrom([
        { type: 'text-delta', text: 'partial' },
        {
          type: 'error',
          error: Object.assign(new Error('late dns-shaped error'), { code: 'EAI_AGAIN' }),
        },
      ]),
    );
    const streamFn = createCallLlmStreamFn({
      languageModel: {} as never,
      retryPreSendDns: true,
      dnsRetryDelaysMs: [0, 0],
    });
    const stream = await streamFn({} as never, { systemPrompt: 'system', messages: [], tools: [] });
    for await (const _event of stream) {
      // drain
    }

    expect(mocks.streamLLM).toHaveBeenCalledTimes(1);
    await expect(stream.result()).resolves.toMatchObject({ stopReason: 'error' });
  });

  it('stops after exactly two DNS retries and safely maps exhaustion', async () => {
    mocks.streamLLM.mockImplementation(() =>
      resultFrom([
        { type: 'error', error: Object.assign(new Error('dns exhausted'), { code: 'EAI_AGAIN' }) },
      ]),
    );
    const streamFn = createCallLlmStreamFn({
      languageModel: {} as never,
      retryPreSendDns: true,
      dnsRetryDelaysMs: [0, 0],
      formatError: () => 'safe provider error',
    });
    const stream = await streamFn({} as never, { systemPrompt: 'system', messages: [], tools: [] });
    for await (const _event of stream) {
      // drain
    }

    expect(mocks.streamLLM).toHaveBeenCalledTimes(3);
    await expect(stream.result()).resolves.toMatchObject({
      stopReason: 'error',
      errorMessage: 'safe provider error',
    });
  });

  it('does not retry a non-DNS setup failure', async () => {
    mocks.streamLLM.mockReturnValue(
      resultFrom([{ type: 'error', error: new Error('provider rejected request') }]),
    );
    const streamFn = createCallLlmStreamFn({
      languageModel: {} as never,
      retryPreSendDns: true,
      dnsRetryDelaysMs: [0, 0],
    });
    const stream = await streamFn({} as never, { systemPrompt: 'system', messages: [], tools: [] });
    for await (const _event of stream) {
      // drain
    }

    expect(mocks.streamLLM).toHaveBeenCalledTimes(1);
    await expect(stream.result()).resolves.toMatchObject({ stopReason: 'error' });
  });

  it('stops a DNS retry wait when the run is aborted', async () => {
    const outer = new AbortController();
    mocks.streamLLM.mockReturnValue(
      resultFrom([
        { type: 'error', error: Object.assign(new Error('dns'), { code: 'EAI_AGAIN' }) },
      ]),
    );
    const streamFn = createCallLlmStreamFn({
      languageModel: {} as never,
      abortSignal: outer.signal,
      retryPreSendDns: true,
      dnsRetryDelaysMs: [60_000, 60_000],
    });
    const stream = await streamFn({} as never, { systemPrompt: 'system', messages: [], tools: [] });
    outer.abort('cancelled during retry');
    for await (const _event of stream) {
      // drain
    }

    expect(mocks.streamLLM).toHaveBeenCalledTimes(1);
    await expect(stream.result()).resolves.toMatchObject({
      stopReason: 'aborted',
      errorMessage: 'cancelled during retry',
    });
  });

  it.each(['outer', 'run'] as const)('pre-aborted %s signal prevents transport', async (owner) => {
    const outer = new AbortController();
    const run = new AbortController();
    (owner === 'outer' ? outer : run).abort(`${owner} cancelled`);

    const { events, message } = await collect([], {
      outerSignal: outer.signal,
      streamOptions: { signal: run.signal },
    });

    expect(mocks.streamLLM).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual(['start', 'error']);
    expect(message).toMatchObject({ stopReason: 'aborted', errorMessage: `${owner} cancelled` });
  });

  it.each(['outer', 'run'] as const)(
    'combines cancellation ownership and settles when the %s signal wins',
    async (owner) => {
      const outer = new AbortController();
      const run = new AbortController();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let transportSignal: AbortSignal | undefined;
      mocks.streamLLM.mockImplementation((...args: unknown[]) => {
        const params = args[0] as { abortSignal?: AbortSignal };
        transportSignal = params?.abortSignal;
        return {
          fullStream: (async function* () {
            await gate;
            yield finish('stop');
          })(),
          usage: new Promise(() => {}),
        };
      });
      const streamFn = createCallLlmStreamFn({
        languageModel: {} as never,
        abortSignal: outer.signal,
      });
      const stream = await streamFn(
        {} as never,
        { systemPrompt: 'system', messages: [], tools: [] },
        { signal: run.signal },
      );
      const eventsPromise = (async () => {
        const events: AssistantMessageEvent[] = [];
        for await (const event of stream) events.push(event);
        return events;
      })();

      (owner === 'outer' ? outer : run).abort(`${owner} cancelled`);
      const message = await stream.result();
      release();
      const events = await eventsPromise;

      expect(transportSignal).not.toBe(outer.signal);
      expect(transportSignal).not.toBe(run.signal);
      expect(transportSignal?.aborted).toBe(true);
      expect(message).toMatchObject({ stopReason: 'aborted', errorMessage: `${owner} cancelled` });
      expect(events.filter((event) => event.type === 'error')).toHaveLength(1);
    },
  );

  it('keeps a captured provider finish when a late abort arrives', async () => {
    const outer = new AbortController();
    const { events, message } = await collect(
      [{ type: 'text-delta', text: 'done' }, finish('stop'), { type: 'error', error: 'late' }],
      { outerSignal: outer.signal },
    );

    outer.abort('too late');

    expect(message.stopReason).toBe('stop');
    expect(events.filter((event) => event.type === 'done' || event.type === 'error')).toHaveLength(
      1,
    );
    expect(events.at(-1)?.type).toBe('done');
  });

  it('keeps a captured provider error when a late abort arrives', async () => {
    const run = new AbortController();
    const { events, message } = await collect(
      [{ type: 'error', error: new Error('provider failed') }, finish('stop')],
      { streamOptions: { signal: run.signal } },
    );

    run.abort('too late');

    expect(message).toMatchObject({ stopReason: 'error', errorMessage: 'provider failed' });
    expect(events.filter((event) => event.type === 'done' || event.type === 'error')).toHaveLength(
      1,
    );
    expect(events.at(-1)?.type).toBe('error');
  });
});
