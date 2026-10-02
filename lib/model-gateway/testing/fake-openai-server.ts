/**
 * Local fake model server for tests and benchmarks.
 *
 * Speaks enough of the OpenAI Chat Completions, OpenAI Responses and Anthropic
 * Messages wire protocols (SSE and JSON) to drive real SDK clients, records
 * every request, and can script errors, rate limits, latency and mid-stream
 * disconnects. Never use it outside tests.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeRequest {
  method: string;
  /** Path without the query string, e.g. `/v1/chat/completions`. */
  path: string;
  query: Record<string, string>;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  rawBody: string;
  /** Parsed JSON body, or undefined when the body is not JSON. */
  body: unknown;
}

export interface FakeUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
}

export interface FakeToolCall {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface FakeTurn {
  text?: string;
  reasoning?: string;
  /** Anthropic thinking signature / OpenAI-compatible reasoning field name. */
  reasoningSignature?: string;
  reasoningField?: 'reasoning_content' | 'reasoning';
  toolCalls?: FakeToolCall[];
  finishReason?: 'stop' | 'length' | 'tool_calls';
  usage?: FakeUsage;
  /** Delay before the response status line and headers. */
  firstByteDelayMs?: number;
  /** Streaming only: send headers and the opening event at once, then wait this long. */
  firstTokenDelayMs?: number;
  /** Split `text` into this many streamed chunks (default 1). */
  textChunks?: number;
  /** Delay between streamed chunks. */
  chunkDelayMs?: number;
  /** Destroy the socket after this many SSE events have been written. */
  disconnectAfterEvents?: number;
}

export type FakeReply =
  | ({ kind: 'auto' } & FakeTurn)
  | {
      kind: 'error';
      status: number;
      body?: unknown;
      headers?: Record<string, string>;
      firstByteDelayMs?: number;
    }
  | { kind: 'raw'; status: number; headers?: Record<string, string>; body: string }
  /** Accept the connection, then reset it before responding. */
  | { kind: 'reset' };

export type FakeHandler = (request: FakeRequest) => FakeReply | Promise<FakeReply>;

export interface FakeModelServer {
  /** Origin, e.g. `http://127.0.0.1:53111`. */
  readonly origin: string;
  /** Recorded requests in arrival order. */
  readonly requests: FakeRequest[];
  setHandler(handler: FakeHandler): void;
  reset(): void;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Protocol = 'openai-chat' | 'openai-responses' | 'anthropic' | 'unknown';

export function detectProtocol(path: string): Protocol {
  if (path.endsWith('/chat/completions')) return 'openai-chat';
  if (path.endsWith('/responses')) return 'openai-responses';
  if (path.endsWith('/messages')) return 'anthropic';
  return 'unknown';
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function splitText(text: string, parts: number): string[] {
  if (parts <= 1 || text.length <= 1) return [text];
  const size = Math.ceil(text.length / parts);
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function modelOf(body: unknown): string {
  const model = (body as { model?: unknown } | undefined)?.model;
  return typeof model === 'string' ? model : 'fake-model';
}

function isStreaming(protocol: Protocol, request: FakeRequest): boolean {
  const body = request.body as { stream?: unknown } | undefined;
  if (protocol === 'unknown') return request.query.alt === 'sse';
  return body?.stream === true;
}

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

function usageOf(turn: FakeTurn): Usage {
  return {
    input: turn.usage?.input ?? 10,
    output: turn.usage?.output ?? 5,
    cacheRead: turn.usage?.cacheRead ?? 0,
    cacheWrite: turn.usage?.cacheWrite ?? 0,
    reasoning: turn.usage?.reasoning ?? 0,
  };
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions
// ---------------------------------------------------------------------------

function openAIChatUsage(usage: Usage) {
  return {
    prompt_tokens: usage.input + usage.cacheRead,
    completion_tokens: usage.output,
    total_tokens: usage.input + usage.cacheRead + usage.output,
    prompt_tokens_details: { cached_tokens: usage.cacheRead },
    completion_tokens_details: { reasoning_tokens: usage.reasoning },
  };
}

function openAIChatEvents(turn: FakeTurn, model: string): string[] {
  const id = 'chatcmpl-fake';
  const base = { id, object: 'chat.completion.chunk', created: 1, model };
  const field = turn.reasoningField ?? 'reasoning_content';
  const events: unknown[] = [
    {
      ...base,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    },
  ];
  if (turn.reasoning) {
    events.push({
      ...base,
      choices: [{ index: 0, delta: { [field]: turn.reasoning }, finish_reason: null }],
    });
  }
  for (const piece of splitText(turn.text ?? '', turn.textChunks ?? 1)) {
    if (!piece) continue;
    events.push({
      ...base,
      choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
    });
  }
  (turn.toolCalls ?? []).forEach((call, index) => {
    events.push({
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index,
                id: call.id ?? `call_${index}`,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
  });
  const finish = turn.finishReason ?? (turn.toolCalls?.length ? 'tool_calls' : 'stop');
  events.push({
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: finish }],
    usage: openAIChatUsage(usageOf(turn)),
  });
  return [...events.map((event) => `data: ${JSON.stringify(event)}\n\n`), 'data: [DONE]\n\n'];
}

function openAIChatJson(turn: FakeTurn, model: string) {
  const message: Record<string, unknown> = { role: 'assistant', content: turn.text ?? '' };
  if (turn.reasoning) message[turn.reasoningField ?? 'reasoning_content'] = turn.reasoning;
  if (turn.toolCalls?.length) {
    message.tool_calls = turn.toolCalls.map((call, index) => ({
      id: call.id ?? `call_${index}`,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    }));
  }
  return {
    id: 'chatcmpl-fake',
    object: 'chat.completion',
    created: 1,
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: turn.finishReason ?? (turn.toolCalls?.length ? 'tool_calls' : 'stop'),
      },
    ],
    usage: openAIChatUsage(usageOf(turn)),
  };
}

// ---------------------------------------------------------------------------
// OpenAI Responses
// ---------------------------------------------------------------------------

function responsesUsage(usage: Usage) {
  return {
    input_tokens: usage.input + usage.cacheRead,
    input_tokens_details: { cached_tokens: usage.cacheRead },
    output_tokens: usage.output,
    output_tokens_details: { reasoning_tokens: usage.reasoning },
    total_tokens: usage.input + usage.cacheRead + usage.output,
  };
}

function responsesOutput(turn: FakeTurn) {
  const output: Record<string, unknown>[] = [];
  if (turn.reasoning) {
    output.push({
      type: 'reasoning',
      id: 'rs_fake',
      summary: [{ type: 'summary_text', text: turn.reasoning }],
      ...(turn.reasoningSignature ? { encrypted_content: turn.reasoningSignature } : {}),
    });
  }
  if (turn.text !== undefined || !turn.toolCalls?.length) {
    output.push({
      type: 'message',
      id: 'msg_fake',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: turn.text ?? '', annotations: [] }],
    });
  }
  (turn.toolCalls ?? []).forEach((call, index) => {
    output.push({
      type: 'function_call',
      id: `fc_${index}`,
      call_id: call.id ?? `call_${index}`,
      name: call.name,
      arguments: JSON.stringify(call.arguments),
      status: 'completed',
    });
  });
  return output;
}

function responsesJson(turn: FakeTurn, model: string) {
  return {
    id: 'resp_fake',
    object: 'response',
    created_at: 1,
    model,
    status: turn.finishReason === 'length' ? 'incomplete' : 'completed',
    incomplete_details: turn.finishReason === 'length' ? { reason: 'max_output_tokens' } : null,
    output: responsesOutput(turn),
    usage: responsesUsage(usageOf(turn)),
  };
}

function responsesEvents(turn: FakeTurn, model: string): string[] {
  const final = responsesJson(turn, model);
  const events: Record<string, unknown>[] = [
    {
      type: 'response.created',
      response: { ...final, status: 'in_progress', output: [], usage: null },
    },
  ];
  final.output.forEach((item, outputIndex) => {
    if (item.type === 'message') {
      const text = turn.text ?? '';
      events.push({
        type: 'response.output_item.added',
        output_index: outputIndex,
        item: { ...item, status: 'in_progress', content: [] },
      });
      events.push({
        type: 'response.content_part.added',
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      });
      for (const piece of splitText(text, turn.textChunks ?? 1)) {
        if (!piece) continue;
        events.push({
          type: 'response.output_text.delta',
          item_id: item.id,
          output_index: outputIndex,
          content_index: 0,
          delta: piece,
          logprobs: [],
        });
      }
      events.push({
        type: 'response.output_text.done',
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        text,
        logprobs: [],
      });
      events.push({
        type: 'response.content_part.done',
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        part: { type: 'output_text', text, annotations: [] },
      });
    } else if (item.type === 'reasoning') {
      events.push({
        type: 'response.output_item.added',
        output_index: outputIndex,
        item: { ...item, summary: [] },
      });
      events.push({
        type: 'response.reasoning_summary_part.added',
        item_id: item.id,
        output_index: outputIndex,
        summary_index: 0,
        part: { type: 'summary_text', text: '' },
      });
      events.push({
        type: 'response.reasoning_summary_text.delta',
        item_id: item.id,
        output_index: outputIndex,
        summary_index: 0,
        delta: turn.reasoning,
      });
      events.push({
        type: 'response.reasoning_summary_part.done',
        item_id: item.id,
        output_index: outputIndex,
        summary_index: 0,
        part: { type: 'summary_text', text: turn.reasoning },
      });
    } else {
      events.push({
        type: 'response.output_item.added',
        output_index: outputIndex,
        item: { ...item, arguments: '', status: 'in_progress' },
      });
      events.push({
        type: 'response.function_call_arguments.delta',
        item_id: item.id,
        output_index: outputIndex,
        delta: item.arguments,
      });
      events.push({
        type: 'response.function_call_arguments.done',
        item_id: item.id,
        output_index: outputIndex,
        arguments: item.arguments,
      });
    }
    events.push({ type: 'response.output_item.done', output_index: outputIndex, item });
  });
  events.push({
    type: final.status === 'incomplete' ? 'response.incomplete' : 'response.completed',
    response: final,
  });
  return events.map(
    (event, index) =>
      `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`,
  );
}

// ---------------------------------------------------------------------------
// Anthropic Messages
// ---------------------------------------------------------------------------

function anthropicUsage(usage: Usage) {
  return {
    input_tokens: usage.input,
    output_tokens: usage.output,
    cache_creation_input_tokens: usage.cacheWrite,
    cache_read_input_tokens: usage.cacheRead,
  };
}

function anthropicStop(turn: FakeTurn): string {
  if (turn.finishReason === 'length') return 'max_tokens';
  if (turn.finishReason === 'tool_calls' || turn.toolCalls?.length) return 'tool_use';
  return 'end_turn';
}

function anthropicContent(turn: FakeTurn) {
  const content: Record<string, unknown>[] = [];
  if (turn.reasoning) {
    content.push({
      type: 'thinking',
      thinking: turn.reasoning,
      signature: turn.reasoningSignature ?? 'sig-fake',
    });
  }
  if (turn.text !== undefined || !turn.toolCalls?.length) {
    content.push({ type: 'text', text: turn.text ?? '' });
  }
  (turn.toolCalls ?? []).forEach((call, index) => {
    content.push({
      type: 'tool_use',
      id: call.id ?? `toolu_${index}`,
      name: call.name,
      input: call.arguments,
    });
  });
  return content;
}

function anthropicJson(turn: FakeTurn, model: string) {
  return {
    id: 'msg_fake',
    type: 'message',
    role: 'assistant',
    model,
    content: anthropicContent(turn),
    stop_reason: anthropicStop(turn),
    stop_sequence: null,
    usage: anthropicUsage(usageOf(turn)),
  };
}

function anthropicEvents(turn: FakeTurn, model: string): string[] {
  const usage = usageOf(turn);
  const events: Record<string, unknown>[] = [
    {
      type: 'message_start',
      message: {
        id: 'msg_fake',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { ...anthropicUsage(usage), output_tokens: 0 },
      },
    },
  ];
  anthropicContent(turn).forEach((block, index) => {
    if (block.type === 'thinking') {
      events.push({
        type: 'content_block_start',
        index,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      });
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'thinking_delta', thinking: block.thinking },
      });
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'signature_delta', signature: block.signature },
      });
    } else if (block.type === 'text') {
      events.push({
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      });
      for (const piece of splitText(String(block.text), turn.textChunks ?? 1)) {
        if (!piece) continue;
        events.push({
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: piece },
        });
      }
    } else {
      events.push({
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      });
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      });
    }
    events.push({ type: 'content_block_stop', index });
  });
  events.push({
    type: 'message_delta',
    delta: { stop_reason: anthropicStop(turn), stop_sequence: null },
    usage: { output_tokens: usage.output },
  });
  events.push({ type: 'message_stop' });
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const defaultHandler: FakeHandler = () => ({ kind: 'auto', text: 'OK' });

async function writeStream(res: ServerResponse, events: string[], turn: FakeTurn): Promise<void> {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.flushHeaders();
  for (let index = 0; index < events.length; index += 1) {
    if (turn.disconnectAfterEvents !== undefined && index >= turn.disconnectAfterEvents) {
      res.socket?.destroy();
      return;
    }
    if (index === 1 && turn.firstTokenDelayMs) await sleep(turn.firstTokenDelayMs);
    else if (index > 0 && turn.chunkDelayMs) await sleep(turn.chunkDelayMs);
    // Separate writes even without a delay, so clients see real chunking.
    else if (index > 0) await new Promise<void>((resolve) => setImmediate(resolve));
    res.write(events[index]);
  }
  res.end();
}

async function respond(res: ServerResponse, request: FakeRequest, reply: FakeReply): Promise<void> {
  if (reply.kind === 'reset') {
    res.socket?.destroy();
    return;
  }
  if (reply.kind === 'raw') {
    res.writeHead(reply.status, reply.headers ?? {});
    res.end(reply.body);
    return;
  }
  if (reply.kind === 'error') {
    if (reply.firstByteDelayMs) await sleep(reply.firstByteDelayMs);
    res.writeHead(reply.status, { 'content-type': 'application/json', ...(reply.headers ?? {}) });
    res.end(
      JSON.stringify(
        reply.body ?? {
          error: { message: `fake upstream error ${reply.status}`, type: 'fake_error' },
        },
      ),
    );
    return;
  }

  if (reply.firstByteDelayMs) await sleep(reply.firstByteDelayMs);
  const protocol = detectProtocol(request.path);
  const model = modelOf(request.body);
  const stream = isStreaming(protocol, request);
  if (protocol === 'unknown') {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({ error: { message: `fake server: unsupported path ${request.path}` } }),
    );
    return;
  }
  if (stream) {
    const events =
      protocol === 'openai-chat'
        ? openAIChatEvents(reply, model)
        : protocol === 'openai-responses'
          ? responsesEvents(reply, model)
          : anthropicEvents(reply, model);
    await writeStream(res, events, reply);
    return;
  }
  // A JSON answer arrives once the whole generation would have streamed.
  const generationMs =
    (reply.firstTokenDelayMs ?? 0) +
    (reply.chunkDelayMs ?? 0) * Math.max(0, (reply.textChunks ?? 1) - 1);
  if (generationMs > 0) await sleep(generationMs);
  const json =
    protocol === 'openai-chat'
      ? openAIChatJson(reply, model)
      : protocol === 'openai-responses'
        ? responsesJson(reply, model)
        : anthropicJson(reply, model);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(json));
}

export async function startFakeModelServer(
  handler?: FakeHandler,
  options: { port?: number } = {},
): Promise<FakeModelServer> {
  let current = handler ?? defaultHandler;
  const requests: FakeRequest[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const rawBody = await readBody(req);
      const url = new URL(req.url ?? '/', 'http://fake.local');
      let body: unknown;
      try {
        body = rawBody ? JSON.parse(rawBody) : undefined;
      } catch {
        body = undefined;
      }
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value;
      }
      const request: FakeRequest = {
        method: req.method ?? 'GET',
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers,
        rawBody,
        body,
      };
      requests.push(request);
      await respond(res, request, await current(request));
    })().catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: String(error) } }));
    });
  });
  server.keepAliveTimeout = 1_000;
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    setHandler(next) {
      current = next;
    },
    reset() {
      requests.length = 0;
      current = handler ?? defaultHandler;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
