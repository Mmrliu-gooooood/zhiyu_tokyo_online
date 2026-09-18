import { describe, expect, it, vi } from 'vitest';

import {
  isCurrentLearningFeedbackRefresh,
  isCurrentLearningFeedbackSnapshot,
  validateLearningSnapshotBeforePersist,
} from '@/components/learning/LearningFeedbackDialog';
import { learningPayload } from './fixtures';

describe('learning-feedback refresh scope', () => {
  it('rejects a late refresh after the dialog moves to another stage or closes', () => {
    expect(
      isCurrentLearningFeedbackRefresh({
        requestEpoch: 1,
        currentEpoch: 2,
        requestStageId: 'stage-a',
        currentStageId: 'stage-b',
        open: true,
      }),
    ).toBe(false);
    expect(
      isCurrentLearningFeedbackRefresh({
        requestEpoch: 2,
        currentEpoch: 2,
        requestStageId: 'stage-b',
        currentStageId: 'stage-b',
        open: false,
      }),
    ).toBe(false);
    expect(
      isCurrentLearningFeedbackRefresh({
        requestEpoch: 2,
        currentEpoch: 2,
        requestStageId: 'stage-b',
        currentStageId: 'stage-b',
        open: true,
      }),
    ).toBe(true);
  });

  it('never reuses a snapshot captured for another stage', () => {
    expect(
      isCurrentLearningFeedbackSnapshot({
        snapshotStageId: 'stage-a',
        currentStageId: 'stage-b',
      }),
    ).toBe(false);
    expect(
      isCurrentLearningFeedbackSnapshot({
        snapshotStageId: 'stage-b',
        currentStageId: 'stage-b',
      }),
    ).toBe(true);
  });

  it('rejects a stage switch that occurs while the current snapshot is rebuilding', async () => {
    const snapshot = learningPayload().source;
    const scenes = [] as const;
    const readCurrent = vi
      .fn()
      .mockReturnValueOnce({ stage: { id: 'stage-1', name: 'Physics' }, scenes })
      .mockReturnValueOnce({ stage: { id: 'stage-2', name: 'Chemistry' }, scenes: [] });

    await expect(
      validateLearningSnapshotBeforePersist('stage-1', snapshot, {
        readCurrent,
        buildSnapshot: async () => snapshot,
      }),
    ).resolves.toBe(false);
    expect(readCurrent).toHaveBeenCalledTimes(2);
  });
});
