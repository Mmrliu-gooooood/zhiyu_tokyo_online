/**
 * Shared perf harness for the model gateway baseline (P0-4) and the later
 * gateway comparisons (P1 / 6.5). Same fake-server shape for every run:
 * 50 ms to first token, 20 text chunks.
 */
import os from 'node:os';
import type { FakeReply } from '@/lib/model-gateway/testing/fake-openai-server';

export const PERF_ITERATIONS = Number(process.env.MODEL_GATEWAY_PERF_ITERATIONS ?? 200);
export const PERF_WARMUP = 10;
export const FIRST_TOKEN_MS = 50;
export const CHUNKS = 20;
/** 0 = chunks are written back to back (separate writes); avoids OS timer granularity. */
export const CHUNK_DELAY_MS = 0;

export const PERF_REPLY: FakeReply = {
  kind: 'auto',
  text: 'The quick brown fox jumps over the lazy dog. '.repeat(4),
  textChunks: CHUNKS,
  firstTokenDelayMs: FIRST_TOKEN_MS,
  usage: { input: 20, output: 40 },
};

export interface Stats {
  n: number;
  mean: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
}

export function stats(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  const round = (v: number) => Math.round(v * 100) / 100;
  return {
    n: sorted.length,
    mean: round(sorted.reduce((sum, v) => sum + v, 0) / sorted.length),
    p50: round(pick(0.5)),
    p95: round(pick(0.95)),
    min: round(sorted[0]),
    max: round(sorted[sorted.length - 1]),
  };
}

export async function measure(
  iterations: number,
  run: () => Promise<{ ttftMs?: number; totalMs: number }>,
): Promise<{ ttft?: Stats; total: Stats }> {
  for (let i = 0; i < PERF_WARMUP; i += 1) await run();
  const ttft: number[] = [];
  const total: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const sample = await run();
    if (sample.ttftMs !== undefined) ttft.push(sample.ttftMs);
    total.push(sample.totalMs);
  }
  return { ...(ttft.length ? { ttft: stats(ttft) } : {}), total: stats(total) };
}

export function environment() {
  return {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    cpus: os.cpus().length,
    iterations: PERF_ITERATIONS,
    warmup: PERF_WARMUP,
    fakeServer: { firstTokenMs: FIRST_TOKEN_MS, chunks: CHUNKS, chunkDelayMs: CHUNK_DELAY_MS },
  };
}
