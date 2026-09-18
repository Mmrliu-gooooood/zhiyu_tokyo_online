import { describe, expect, it } from 'vitest';

import { getLearningCheckReadiness } from '@/lib/learning/readiness';

describe('getLearningCheckReadiness', () => {
  it('conservatively blocks incomplete generation without blocking stable legacy imports', () => {
    expect(
      getLearningCheckReadiness({
        generationComplete: true,
        generationStatus: 'completed',
        outlineProducer: 'server-job',
        scenes: [{ id: 'scene-1', order: 0 }],
        outlines: [{ id: 'outline-1', order: 0 }],
        generatingOutlines: [],
        failedOutlines: [],
      }),
    ).toEqual({ ready: true });

    expect(
      getLearningCheckReadiness({
        generationComplete: false,
        generationStatus: 'idle',
        outlineProducer: 'server-job',
        scenes: [{ id: 'scene-1', order: 0 }],
        outlines: [{ id: 'outline-1', order: 0 }],
        generatingOutlines: [],
        failedOutlines: [],
      }),
    ).toEqual({ ready: false, reason: 'server-generation-incomplete' });

    expect(
      getLearningCheckReadiness({
        generationComplete: false,
        generationStatus: 'paused',
        outlineProducer: 'client',
        scenes: [{ id: 'scene-1', order: 0 }],
        outlines: [
          { id: 'outline-1', order: 0 },
          { id: 'outline-2', order: 1 },
        ],
        generatingOutlines: [],
        failedOutlines: [],
      }),
    ).toEqual({ ready: false, reason: 'local-generation-incomplete' });

    expect(
      getLearningCheckReadiness({
        generationComplete: false,
        generationStatus: 'idle',
        outlineProducer: null,
        scenes: [{ id: 'scene-1', order: 0 }],
        outlines: [],
        generatingOutlines: [],
        failedOutlines: [],
      }),
    ).toEqual({ ready: true });
  });
});
