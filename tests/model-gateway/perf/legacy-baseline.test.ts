/**
 * P0-4 performance baseline of the LEGACY stack against the fake server.
 * Opt-in (it takes a few minutes):
 *
 *   $env:MODEL_GATEWAY_PERF = '1'; pnpm exec vitest run tests/model-gateway/perf
 *
 * Writes tests/fixtures/model-gateway/perf-baseline.json. Compare gateway runs
 * against it on the same machine (plan section 6.5).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StreamFn } from '@earendil-works/pi-agent-core';

vi.mock('@/lib/server/usage-storage', () => ({ recordUsage: vi.fn(async () => undefined) }));

import { callLLM, streamLLM } from '@/lib/ai/llm';
import { getModel } from '@/lib/ai/providers';
import { createCallLlmStreamFn } from '@/lib/agent/runtime/stream-fn';
import {
  startFakeModelServer,
  type FakeModelServer,
} from '@/lib/model-gateway/testing/fake-openai-server';
import { PERF_ITERATIONS, PERF_REPLY, environment, measure } from './harness';

const ENABLED = process.env.MODEL_GATEWAY_PERF === '1';
const OUTPUT = path.join(process.cwd(), 'tests', 'fixtures', 'model-gateway', 'perf-baseline.json');

let server: FakeModelServer;

beforeAll(async () => {
  if (!ENABLED) return;
  server = await startFakeModelServer(() => PERF_REPLY);
});
afterAll(async () => {
  await server?.close();
});

function legacyModel() {
  return getModel({
    providerId: 'deepseek',
    modelId: 'deepseek-flash',
    apiKey: 'sk-perf',
    baseUrl: `${server.origin}/v1`,
  }).model;
}

const PROMPT = [{ role: 'user' as const, content: 'Hello' }];

describe.skipIf(!ENABLED)('legacy stack performance baseline', () => {
  it('measures callLLM, streamLLM and the PRO StreamFn', { timeout: 900_000 }, async () => {
    const model = legacyModel();

    const complete = await measure(PERF_ITERATIONS, async () => {
      const started = performance.now();
      const result = await callLLM({ model, messages: PROMPT, maxRetries: 0 }, 'perf');
      expect(result.text.length).toBeGreaterThan(0);
      return { totalMs: performance.now() - started };
    });

    const stream = await measure(PERF_ITERATIONS, async () => {
      const started = performance.now();
      let ttftMs: number | undefined;
      const result = streamLLM({ model, messages: PROMPT, maxRetries: 0 }, 'perf');
      for await (const delta of result.textStream) {
        if (ttftMs === undefined && delta) ttftMs = performance.now() - started;
      }
      return { ttftMs, totalMs: performance.now() - started };
    });

    const streamFn: StreamFn = createCallLlmStreamFn({
      languageModel: model,
      source: 'perf',
      maxRetries: 0,
    });
    const proTurn = await measure(PERF_ITERATIONS, async () => {
      const started = performance.now();
      let ttftMs: number | undefined;
      const events = await streamFn(
        {} as Parameters<StreamFn>[0],
        { systemPrompt: '', messages: [{ role: 'user', content: 'Hello', timestamp: 0 }] },
        {},
      );
      for await (const event of events) {
        if (ttftMs === undefined && event.type === 'text_delta') {
          ttftMs = performance.now() - started;
        }
      }
      return { ttftMs, totalMs: performance.now() - started };
    });

    const report = {
      recordedAt: new Date().toISOString(),
      stack: 'legacy (getModel + AI SDK callLLM/streamLLM, deepseek compat transport)',
      environment: environment(),
      callLLM: complete,
      streamLLM: stream,
      proStreamFnTurn: proTurn,
    };
    mkdirSync(path.dirname(OUTPUT), { recursive: true });
    writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
  });
});
