import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDocument } from '@/lib/document-store';
import type { Scene } from '@/lib/types/stage';

const mocks = vi.hoisted(() => ({ getState: vi.fn(), setState: vi.fn(), deleted: vi.fn() }));
vi.mock('@/lib/store/stage', () => ({
  useStageStore: { getState: mocks.getState, setState: mocks.setState },
}));
vi.mock('@/lib/utils/deleted-stages', () => ({ isStageDeleted: mocks.deleted }));
import {
  hydrateGenerationDocument,
  projectClassroomGenerationSnapshot,
} from '@/lib/hooks/use-generation-job';

const scene: Scene = {
  id: 'scene-1',
  stageId: 'a',
  title: 'Quiz',
  order: 0,
  type: 'quiz',
  content: { type: 'quiz', questions: [] },
};
const document: AppDocument = {
  stage: { id: 'a', name: 'Physics', createdAt: 1, updatedAt: 1 },
  scenes: [scene],
  outline: {
    outlines: [],
    producer: 'server-job',
    producerKind: 'course-worker',
    producerRef: 'job',
    generationComplete: false,
    createdAt: 1,
    updatedAt: 1,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.deleted.mockReturnValue(false);
  mocks.getState.mockReturnValue({
    stage: document.stage,
    scenes: [scene],
    currentSceneId: scene.id,
    chats: [{ id: 'chat' }],
    mode: 'playback',
  });
});

describe('generation observation hydration', () => {
  it('never schedules persistence and leaves chat, playback and mode untouched', () => {
    expect(hydrateGenerationDocument('a', document)).toBe(true);
    const patch = mocks.setState.mock.calls[0][0];
    expect(patch.currentSceneId).toBe('scene-1');
    expect(patch.scenes[0]).toBe(scene);
    expect(patch).not.toHaveProperty('chats');
    expect(patch).not.toHaveProperty('mode');
    expect(patch.outlineProducer).toBe('server-job');
    expect(patch.generationComplete).toBe(false);
  });
  it('rejects a late response for a departed classroom or deleted stage', () => {
    mocks.getState.mockReturnValue({ stage: { id: 'b' }, scenes: [] });
    expect(hydrateGenerationDocument('a', document)).toBe(false);
    mocks.getState.mockReturnValue({ stage: { id: 'a' }, scenes: [] });
    mocks.deleted.mockReturnValue(true);
    expect(hydrateGenerationDocument('a', document)).toBe(false);
    expect(mocks.setState).not.toHaveBeenCalled();
  });
});

describe('classroom generation projection', () => {
  const outlines = Array.from({ length: 12 }, (_, index) => ({
    id: `scene_${index + 1}`,
    type: 'slide' as const,
    title: `Scene ${index + 1}`,
    description: 'Test',
    keyPoints: ['Key'],
    order: index,
  }));

  it('marks the current unfinished page stopped when the job needs attention', () => {
    const projected = projectClassroomGenerationSnapshot(
      {
        jobId: 'job',
        stageId: 'a',
        status: 'needs_attention',
        retryAt: null,
        scenes: [
          ...outlines.slice(0, 6).map((outline) => ({
            outlineId: outline.id,
            sceneId: outline.id,
            ordinal: outline.order,
            status: 'ready',
          })),
          { outlineId: 'scene_7', sceneId: 'scene_7', ordinal: 6, status: 'retry_wait' },
          { outlineId: 'scene_8', sceneId: 'scene_8', ordinal: 7, status: 'needs_attention' },
          { outlineId: 'scene_9', sceneId: 'scene_9', ordinal: 8, status: 'needs_attention' },
          ...outlines.slice(9).map((outline) => ({
            outlineId: outline.id,
            sceneId: outline.id,
            ordinal: outline.order,
            status: 'pending',
          })),
        ],
        displayProgress: {
          phase: 'actions',
          content: { completed: 9, total: 12, active: 0 },
          actions: { completed: 6, total: 12, active: 0 },
          speech: { completed: 0, total: null, active: 0, skipped: 0 },
          published: { completed: 6, total: 12 },
          issues: [
            {
              outlineId: 'scene_7',
              phase: 'actions',
              code: 'PROVIDER_REQUEST_NOT_SENT',
              state: 'retry_wait',
            },
            {
              outlineId: 'scene_8',
              phase: 'content',
              code: 'EXTERNAL_RESULT_UNKNOWN',
              state: 'unknown',
            },
            {
              outlineId: 'scene_9',
              phase: 'content',
              code: 'EXTERNAL_RESULT_UNKNOWN',
              state: 'unknown',
            },
          ],
        },
      } as never,
      outlines,
    );

    expect(projected.generationStatus).toBe('error');
    expect(projected.failedOutlines.map((outline) => outline.id)).toEqual(
      outlines.slice(6).map((outline) => outline.id),
    );
    expect(projected.display).toMatchObject({
      executing: false,
      stopped: true,
      recovery: 'confirm_unknown',
      affectedOutlineIds: outlines.slice(6).map((outline) => outline.id),
    });
  });

  it.each([
    ['retry_wait', 'paused'],
    ['cancelled', 'paused'],
    ['failed', 'error'],
    ['succeeded', 'completed'],
  ] as const)('maps %s without treating it as active generation', (status, generationStatus) => {
    const projected = projectClassroomGenerationSnapshot(
      {
        status,
        retryAt: status === 'retry_wait' ? '2030-01-02T03:04:05.000Z' : null,
        scenes: [{ outlineId: 'scene_1', status }],
      } as never,
      outlines,
    );
    expect(projected.generationStatus).toBe(generationStatus);
    expect(projected.display.executing).toBe(false);
    expect(projected.failedOutlines).toEqual(status === 'failed' ? [outlines[0]] : []);
  });
});
