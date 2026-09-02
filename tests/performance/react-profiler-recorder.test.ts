import { describe, expect, it } from 'vitest';

import { createReactProfilerRecorder } from './react-profiler-recorder';

describe('Phase 0 React Profiler reporting', () => {
  it('reports nearest-rank percentiles and explicit zero-commit islands', () => {
    const recorder = createReactProfilerRecorder();
    for (const duration of [1, 2, 3, 4]) {
      recorder.onRender('PlaybackChromeRoot', 'update', duration, 5, 10, 20);
    }

    expect(
      recorder.report('speech-progress-100', 100, ['PlaybackChromeRoot', 'SceneRail']),
    ).toEqual({
      scenario: 'speech-progress-100',
      eventCount: 100,
      islands: {
        PlaybackChromeRoot: { commits: 4, p50Ms: 2, p95Ms: 4, maxMs: 4 },
        SceneRail: { commits: 0, p50Ms: null, p95Ms: null, maxMs: null },
      },
    });
  });

  it('drops warmup samples when a measured scenario starts', () => {
    const recorder = createReactProfilerRecorder();
    recorder.onRender('PlaybackChromeRoot', 'mount', 9, 9, 0, 9);

    recorder.reset();
    recorder.onRender('PlaybackChromeRoot', 'update', 2.34567, 3, 10, 12);

    expect(recorder.report('thinking-100', 100, ['PlaybackChromeRoot'])).toEqual({
      scenario: 'thinking-100',
      eventCount: 100,
      islands: {
        PlaybackChromeRoot: { commits: 1, p50Ms: 2.346, p95Ms: 2.346, maxMs: 2.346 },
      },
    });
  });
});
