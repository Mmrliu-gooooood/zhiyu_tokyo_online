import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDocument } from '@/lib/document-store';
import type { Scene } from '@/lib/types/stage';

const mocks = vi.hoisted(() => ({ getState: vi.fn(), setState: vi.fn(), deleted: vi.fn() }));
vi.mock('@/lib/store/stage', () => ({
  useStageStore: { getState: mocks.getState, setState: mocks.setState },
}));
vi.mock('@/lib/utils/deleted-stages', () => ({ isStageDeleted: mocks.deleted }));
import { hydrateGenerationDocument } from '@/lib/hooks/use-generation-job';

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
