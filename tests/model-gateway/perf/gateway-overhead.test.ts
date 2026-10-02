/**
 * Performance gate (plan 6.5), opt-in:
 *
 *   $env:MODEL_GATEWAY_PERF = '1'; pnpm exec vitest run tests/model-gateway/perf
 *
 * - Gateway overhead vs a direct pi call (paired, interleaved): p50 ≤ 5 ms, p95 ≤ 15 ms.
 * - Per-call `Models` view construction: p50 < 0.2 ms.
 * - `complete` total and `stream` TTFT p50 ≤ 1.10 × the P0-4 legacy baseline.
 * - PRO single turn (Agent StreamFn → gateway) p50 ≤ the legacy StreamFn baseline.
 * The report is written to tests/fixtures/model-gateway/perf-gateway.json.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { userText } from '@/lib/model-gateway';
import { createGatewayStreamFn } from '@/lib/model-gateway/adapters/agent-stream-fn';
import { sealedAuthContext } from '@/lib/model-gateway/credentials/auth-context';
import {
  createCallModels,
  loadPiProvider,
  streamModel,
} from '@/lib/model-gateway/runtime/pi-registry';
import {
  startFakeModelServer,
  type FakeModelServer,
} from '@/lib/model-gateway/testing/fake-openai-server';
import { bindingFor, testGateway } from '../helpers';
import { PERF_ITERATIONS, PERF_REPLY, PERF_WARMUP, environment, measure, stats } from './harness';

const ENABLED = process.env.MODEL_GATEWAY_PERF === '1';
const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'model-gateway');

let server: FakeModelServer;
beforeAll(async () => {
  if (ENABLED) server = await startFakeModelServer(() => PERF_REPLY);
});
afterAll(async () => {
  await server?.close();
});

describe.skipIf(!ENABLED)('gateway performance gate', () => {
  it('meets the overhead and Models-view thresholds', { timeout: 900_000 }, async () => {
    const provider = await loadPiProvider('deepseek');
    const binding = await bindingFor('deepseek', 'deepseek-flash', server.origin);
    const { gateway } = testGateway();
    const request = { messages: [userText('Hello', 0)] };

    // Models view construction.
    const construct: number[] = [];
    for (let i = 0; i < 2_000; i += 1) {
      const started = performance.now();
      createCallModels(provider, sealedAuthContext());
      construct.push(performance.now() - started);
    }
    const constructStats = stats(construct.slice(200));

    const direct = async () => {
      const started = performance.now();
      const models = createCallModels(provider, sealedAuthContext());
      const message = await streamModel(
        models,
        binding.model,
        { messages: request.messages as never },
        {
          apiKey: 'sk-request-key',
          maxRetries: 0,
        },
      ).result();
      if (message.stopReason !== 'stop') throw new Error(message.errorMessage);
      return performance.now() - started;
    };
    const viaGateway = async () => {
      const started = performance.now();
      await gateway.complete(binding, request, { source: 'perf' });
      return performance.now() - started;
    };
    for (let i = 0; i < PERF_WARMUP; i += 1) {
      await direct();
      await viaGateway();
    }
    const overhead: number[] = [];
    const directTimes: number[] = [];
    const gatewayTimes: number[] = [];
    for (let i = 0; i < PERF_ITERATIONS; i += 1) {
      const a = await direct();
      const b = await viaGateway();
      directTimes.push(a);
      gatewayTimes.push(b);
      overhead.push(b - a);
    }

    const streamRun = await measure(PERF_ITERATIONS, async () => {
      const started = performance.now();
      let ttftMs: number | undefined;
      for await (const delta of gateway.stream(binding, request, { source: 'perf' }).textStream()) {
        if (ttftMs === undefined && delta) ttftMs = performance.now() - started;
      }
      return { ttftMs, totalMs: performance.now() - started };
    });

    // PRO single turn: the Agent StreamFn adapter over the same gateway.
    const streamFn = createGatewayStreamFn({ binding, source: 'perf', gateway });
    const proTurn = await measure(PERF_ITERATIONS, async () => {
      const started = performance.now();
      let ttftMs: number | undefined;
      const events = await streamFn(
        {} as Parameters<typeof streamFn>[0],
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

    // Same pairing with an instant fake server: isolates the gateway's own cost
    // from OS timer jitter on the 50 ms first-token delay.
    server.setHandler(() => ({ ...PERF_REPLY, firstTokenDelayMs: 0 }));
    const instantOverhead: number[] = [];
    for (let i = 0; i < PERF_ITERATIONS; i += 1) {
      const a = await direct();
      const b = await viaGateway();
      instantOverhead.push(b - a);
    }
    server.setHandler(() => PERF_REPLY);

    const baseline = JSON.parse(readFileSync(path.join(FIXTURES, 'perf-baseline.json'), 'utf8'));
    const report = {
      recordedAt: new Date().toISOString(),
      environment: environment(),
      modelsViewConstructionMs: constructStats,
      directPiCompleteMs: stats(directTimes),
      gatewayCompleteMs: stats(gatewayTimes),
      gatewayOverheadMs: stats(overhead),
      gatewayOverheadInstantServerMs: stats(instantOverhead),
      gatewayStream: streamRun,
      gatewayProStreamFnTurn: proTurn,
      legacyBaseline: {
        legacyComplete: baseline.legacyComplete.total,
        legacyStream: baseline.legacyStream,
        proStreamFnTurn: baseline.proStreamFnTurn,
      },
    };
    writeFileSync(
      path.join(FIXTURES, 'perf-gateway.json'),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    console.log(JSON.stringify(report, null, 2));

    expect(constructStats.p50).toBeLessThan(0.2);
    expect(report.gatewayOverheadMs.p50).toBeLessThanOrEqual(5);
    expect(report.gatewayOverheadMs.p95).toBeLessThanOrEqual(15);
    expect(report.gatewayCompleteMs.p50).toBeLessThanOrEqual(
      baseline.legacyComplete.total.p50 * 1.1,
    );
    expect(streamRun.ttft!.p50).toBeLessThanOrEqual(baseline.legacyStream.ttft.p50 * 1.1);
    expect(proTurn.total.p50).toBeLessThanOrEqual(baseline.proStreamFnTurn.total.p50);
  });
});
