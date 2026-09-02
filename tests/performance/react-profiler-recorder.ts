import type { ProfilerOnRenderCallback } from 'react';

type IslandReport = {
  readonly commits: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly maxMs: number | null;
};

export type ReactProfilerScenarioReport = {
  readonly scenario: string;
  readonly eventCount: number;
  readonly islands: Readonly<Record<string, IslandReport>>;
};

function rounded(value: number): number {
  return Number(value.toFixed(3));
}

function nearestRank(sorted: readonly number[], percentile: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.ceil(percentile * sorted.length) - 1] ?? null;
}

export function createReactProfilerRecorder(): {
  readonly onRender: ProfilerOnRenderCallback;
  readonly reset: () => void;
  readonly report: (
    scenario: string,
    eventCount: number,
    profilerIds: readonly string[],
  ) => ReactProfilerScenarioReport;
} {
  const durations = new Map<string, number[]>();

  const onRender: ProfilerOnRenderCallback = (id, _phase, actualDuration) => {
    const samples = durations.get(id) ?? [];
    samples.push(actualDuration);
    durations.set(id, samples);
  };

  return {
    onRender,
    reset: () => durations.clear(),
    report: (scenario, eventCount, profilerIds) => ({
      scenario,
      eventCount,
      islands: Object.fromEntries(
        profilerIds.map((id) => {
          const samples = [...(durations.get(id) ?? [])].sort((left, right) => left - right);
          const p50 = nearestRank(samples, 0.5);
          const p95 = nearestRank(samples, 0.95);
          return [
            id,
            {
              commits: samples.length,
              p50Ms: p50 === null ? null : rounded(p50),
              p95Ms: p95 === null ? null : rounded(p95),
              maxMs: samples.length === 0 ? null : rounded(samples[samples.length - 1]),
            },
          ];
        }),
      ),
    }),
  };
}
