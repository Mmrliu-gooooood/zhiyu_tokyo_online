/**
 * P0-3 characterization: drive the LEGACY stack (`getModel` + `callLLM` /
 * `streamLLM`) against the local fake model server and lock the semantic
 * request payload for every provider into golden files.
 *
 *   UPDATE_LEGACY_GOLDEN=1 pnpm exec vitest run tests/model-gateway/characterization
 *
 * rewrites tests/fixtures/model-gateway/legacy-payloads/*.json. Without the
 * flag the test asserts the legacy stack still produces exactly the goldens.
 * The goldens carry each case's input so P2-5 can replay them through the
 * gateway after the legacy catalog is gone.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { tool, type ModelMessage } from 'ai';
import { z } from 'zod';

vi.mock('@/lib/server/usage-storage', () => ({ recordUsage: vi.fn(async () => undefined) }));

import { callLLM, streamLLM } from '@/lib/ai/llm';
import { getModel } from '@/lib/ai/providers';
import {
  startFakeModelServer,
  type FakeModelServer,
} from '@/lib/model-gateway/testing/fake-openai-server';
import type { ProviderId, ProviderType, ThinkingConfig } from '@/lib/types/provider';
import {
  AZURE_TEST_BASE_URL,
  LEGACY_PROVIDER_IDS,
  casesForProvider,
  projectRequest,
  representativeModels,
  sortKeys,
  thinkingVariants,
  type GoldenRecord,
} from './matrix';

export type Conversation = 'single' | 'reasoning-replay' | 'tool-replay' | 'image';

export interface LegacyCaseInput {
  providerId: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  providerType?: ProviderType;
  api?: 'openai-completions' | 'openai-responses';
  thinking?: ThinkingConfig;
  tools: boolean;
  stream: boolean;
  conversation: Conversation;
  maxOutputTokens?: number;
  env?: Record<string, string>;
}

export interface GoldenEntry {
  input: LegacyCaseInput;
  request: GoldenRecord | { error: string };
}

const FIXTURE_DIR = path.join(
  process.cwd(),
  'tests',
  'fixtures',
  'model-gateway',
  'legacy-payloads',
);
const UPDATE = process.env.UPDATE_LEGACY_GOLDEN === '1';
const SYSTEM = 'You are a characterization test.';
const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function testKey(providerId: string): string {
  return `sk-test-${providerId}-0123456789`;
}

function conversation(kind: Conversation): ModelMessage[] {
  switch (kind) {
    case 'single':
      return [{ role: 'user', content: 'Hello' }];
    case 'image':
      return [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe the image.' },
            { type: 'image', image: PNG_1X1, mediaType: 'image/png' },
          ],
        },
      ];
    case 'reasoning-replay':
      return [
        { role: 'user', content: 'What is 2+2?' },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'Add the two numbers.' },
            { type: 'text', text: '4' },
          ],
        },
        { role: 'user', content: 'And 3+3?' },
      ];
    case 'tool-replay':
      return [
        { role: 'user', content: 'Look up X.' },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'I need the lookup tool.' },
            { type: 'tool-call', toolCallId: 'call_1', toolName: 'lookup', input: { query: 'X' } },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call_1',
              toolName: 'lookup',
              output: { type: 'json', value: { answer: '42' } },
            },
          ],
        },
        { role: 'user', content: 'Summarize.' },
      ];
  }
}

const TOOLS = {
  lookup: tool({
    description: 'Look up a fact.',
    inputSchema: z.object({ query: z.string().describe('What to look up') }),
  }),
};

function matrixInputs(providerId: string): Array<[string, LegacyCaseInput]> {
  const models = new Map(representativeModels(providerId).map((m) => [m.modelId, m]));
  return casesForProvider(providerId).map((c) => [
    c.id,
    {
      providerId,
      modelId: c.modelId,
      apiKey: testKey(providerId),
      ...(providerId === 'azure' ? { baseUrl: AZURE_TEST_BASE_URL } : {}),
      ...(c.thinking.config ? { thinking: c.thinking.config } : {}),
      tools: c.tools,
      stream: c.stream,
      conversation: 'single',
      ...(models.get(c.modelId)?.modelInfo?.outputWindow
        ? { maxOutputTokens: models.get(c.modelId)!.modelInfo!.outputWindow }
        : {}),
    },
  ]);
}

/** Multi-turn replay, image input and global-override cases. */
function specialInputs(providerId: string): Array<[string, LegacyCaseInput]> {
  const out: Array<[string, LegacyCaseInput]> = [];
  const base = {
    providerId,
    apiKey: testKey(providerId),
    ...(providerId === 'azure' ? { baseUrl: AZURE_TEST_BASE_URL } : {}),
  };
  const models = representativeModels(providerId);
  for (const model of models) {
    const enabled = thinkingVariants(model.thinking).find((v) => v.label === 'enabled')!.config;
    for (const kind of ['reasoning-replay', 'tool-replay'] as const) {
      out.push([
        `${model.modelId}|${kind}|thinking=enabled|tools=1|stream`,
        {
          ...base,
          modelId: model.modelId,
          thinking: enabled,
          tools: true,
          stream: true,
          conversation: kind,
        },
      ]);
    }
  }
  const first = models[0];
  out.push([
    `${first.modelId}|image|thinking=unset|tools=0|stream`,
    { ...base, modelId: first.modelId, tools: false, stream: true, conversation: 'image' },
  ]);
  const thinkingModel = models.find((m) => m.thinking && m.thinking.control !== 'none');
  if (thinkingModel) {
    out.push([
      `${thinkingModel.modelId}|env=LLM_THINKING_DISABLED|thinking=unset|tools=0|stream`,
      {
        ...base,
        modelId: thinkingModel.modelId,
        tools: false,
        stream: true,
        conversation: 'single',
        env: { LLM_THINKING_DISABLED: 'true' },
      },
    ]);
  }

  if (providerId === 'openai') {
    const gateway = 'https://gateway.example/v1';
    for (const [modelId, labels] of [
      ['deepseek-v4-flash-vision-exp', ['unset', 'enabled', 'disabled']],
      ['gpt-5.4', ['unset', 'enabled']],
    ] as const) {
      for (const label of labels) {
        for (const stream of [false, true]) {
          out.push([
            `custom-base-url|${modelId}|thinking=${label}|tools=0|${stream ? 'stream' : 'generate'}`,
            {
              ...base,
              modelId,
              baseUrl: gateway,
              ...(label === 'unset' ? {} : { thinking: { mode: label as 'enabled' | 'disabled' } }),
              tools: false,
              stream,
              conversation: 'single',
            },
          ]);
        }
      }
    }
    out.push([
      'custom-base-url|gpt-5.4|api=openai-responses|thinking=unset|tools=0|stream',
      {
        ...base,
        modelId: 'gpt-5.4',
        baseUrl: gateway,
        api: 'openai-responses',
        tools: false,
        stream: true,
        conversation: 'single',
      },
    ]);
    out.push([
      'gpt-5.6|api=openai-completions|thinking=enabled|tools=0|stream',
      {
        ...base,
        modelId: 'gpt-5.6',
        api: 'openai-completions',
        thinking: { mode: 'enabled' },
        tools: false,
        stream: true,
        conversation: 'single',
      },
    ]);
  }
  if (providerId === 'minimax') {
    for (const modelId of ['MiniMax-M3', 'MiniMax-M2.7']) {
      out.push([
        `${modelId}|key=sk-cp|thinking=disabled|tools=0|stream`,
        {
          ...base,
          apiKey: 'sk-cp-test-minimax-0123456789',
          modelId,
          thinking: { mode: 'disabled' },
          tools: false,
          stream: true,
          conversation: 'single',
        },
      ]);
    }
  }
  return out;
}

/** A user-defined OpenAI-compatible provider (custom-*), outside the 19 built-ins. */
function customProviderInputs(): Array<[string, LegacyCaseInput]> {
  const out: Array<[string, LegacyCaseInput]> = [];
  for (const thinking of [undefined, { mode: 'enabled' } as ThinkingConfig]) {
    for (const stream of [false, true]) {
      out.push([
        `custom-gateway|my-model|thinking=${thinking ? 'enabled' : 'unset'}|tools=1|${stream ? 'stream' : 'generate'}`,
        {
          providerId: 'custom-gateway',
          providerType: 'openai',
          modelId: 'my-model',
          apiKey: testKey('custom'),
          baseUrl: 'https://custom-gateway.example/v1',
          ...(thinking ? { thinking } : {}),
          tools: true,
          stream,
          conversation: 'single',
        },
      ]);
    }
  }
  return out;
}

let server: FakeModelServer;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  server = await startFakeModelServer();
  // Route every outbound request to the fake server, remembering the real host.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const original = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (original.protocol !== 'http:' && original.protocol !== 'https:') {
      return realFetch(input, init);
    }
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.set('x-characterization-host', original.host);
    const body = init?.body ?? (input instanceof Request ? await input.text() : undefined);
    return realFetch(`${server.origin}${original.pathname}${original.search}`, {
      ...init,
      method: init?.method ?? (input instanceof Request ? input.method : undefined),
      headers,
      body,
    });
  }) as typeof globalThis.fetch;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await server?.close();
});

async function captureLegacy(input: LegacyCaseInput): Promise<GoldenEntry['request']> {
  const savedEnv: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(input.env ?? {})) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
  const before = server.requests.length;
  try {
    let model;
    try {
      ({ model } = getModel({
        providerId: input.providerId as ProviderId,
        modelId: input.modelId,
        apiKey: input.apiKey,
        baseUrl: input.baseUrl,
        providerType: input.providerType,
        api: input.api,
      }));
    } catch (error) {
      return { error: `getModel: ${(error as Error).message}` };
    }
    const params = {
      model,
      system: SYSTEM,
      messages: conversation(input.conversation),
      maxRetries: 0,
      ...(input.maxOutputTokens ? { maxOutputTokens: input.maxOutputTokens } : {}),
      ...(input.tools ? { tools: TOOLS } : {}),
    };
    if (input.stream) {
      const result = streamLLM(params, 'characterization', input.thinking);
      try {
        for await (const part of result.fullStream) void part;
      } catch {
        // Only the outbound request matters here.
      }
    } else {
      await callLLM(params, 'characterization', undefined, input.thinking).catch(() => undefined);
    }
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const request = server.requests[before];
  if (!request) return { error: 'no request was sent' };
  return projectRequest(
    {
      method: request.method,
      host: request.headers['x-characterization-host'] ?? '',
      path: request.path,
      query: request.query,
      headers: request.headers,
      body: request.body ?? request.rawBody,
    },
    input.apiKey,
  );
}

async function recordGroup(name: string, inputs: Array<[string, LegacyCaseInput]>) {
  const entries: Record<string, GoldenEntry> = {};
  for (const [id, input] of inputs) {
    if (entries[id]) throw new Error(`duplicate characterization case id ${id}`);
    entries[id] = { input, request: await captureLegacy(input) };
  }
  const golden = sortKeys({ group: name, cases: entries });
  const file = path.join(FIXTURE_DIR, `${name}.json`);
  if (UPDATE) {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    writeFileSync(file, `${JSON.stringify(golden, null, 2)}\n`);
    return;
  }
  if (!existsSync(file)) {
    throw new Error(`missing golden ${file}; run with UPDATE_LEGACY_GOLDEN=1`);
  }
  expect(golden).toEqual(JSON.parse(readFileSync(file, 'utf8')));
}

describe('legacy request payload characterization', () => {
  it('covers all 19 built-in providers', () => {
    expect(LEGACY_PROVIDER_IDS).toHaveLength(19);
  });

  for (const providerId of LEGACY_PROVIDER_IDS) {
    it(`records ${providerId}`, { timeout: 120_000 }, async () => {
      await recordGroup(providerId, [...matrixInputs(providerId), ...specialInputs(providerId)]);
    });
  }

  it('records a custom OpenAI-compatible provider', { timeout: 60_000 }, async () => {
    await recordGroup('custom-provider', customProviderInputs());
  });
});
