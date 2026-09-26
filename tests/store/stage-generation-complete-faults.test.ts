/**
 * P1-2 controlled fault positions for foreground completion, with browser
 * persistence on: (1) the final save fails, (2) the save lands but completion
 * keeps failing, (3) completion lands but the response is lost, (4) the tab is
 * reopened. Each must converge: the slot is released immediately, or on
 * reopen, or at worst by lease expiry — and never before the document says
 * complete.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  saveStageData: vi.fn(),
  loadStageData: vi.fn(),
  complete: vi.fn(),
  toastWarning: vi.fn(),
}));

vi.mock('@/lib/pbl/v2/runtime/hydration', () => ({
  hydratePBLScenesFromRuntime: async (_stageId: string, scenes: unknown[]) => scenes,
}));
vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageData: (...args: unknown[]) => mocks.saveStageData(...args),
  saveStageDataIncremental: vi.fn().mockResolvedValue(undefined),
  loadStageData: (...args: unknown[]) => mocks.loadStageData(...args),
}));
vi.mock('@/lib/persistence/bootstrap', () => ({ isBrowserPersistenceEnabled: () => true }));
vi.mock('sonner', () => ({ toast: { warning: mocks.toastWarning } }));
vi.mock('@/lib/generation/foreground-root-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/generation/foreground-root-client')>()),
  completeForegroundGenerationRoot: (...args: unknown[]) => mocks.complete(...args),
}));

import { awaitStageSelfHealSave, useStageStore } from '@/lib/store/stage';
import { ForegroundCompletionError } from '@/lib/generation/foreground-root-client';
import {
  compensateForegroundCompletion,
  resetForegroundCompletionCompensationForTests,
} from '@/lib/generation/foreground-completion-compensation';
import type { Scene, Stage } from '@/lib/types/stage';
import type { SceneOutline } from '@/lib/types/generation';

function makeStage(id = 'stage-f'): Stage {
  return { id, name: 'Fault stage', createdAt: 1, updatedAt: 1 };
}

function makeScene(order: number, stageId = 'stage-f'): Scene {
  return {
    id: `scene-${order}`,
    stageId,
    type: 'slide',
    title: `scene ${order}`,
    order,
    content: {
      type: 'slide',
      canvas: {
        id: `canvas-${order}`,
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: {
          backgroundColor: '#fff',
          themeColors: ['#000'],
          fontColor: '#000',
          fontName: 'Inter',
        },
        elements: [],
      },
    },
  };
}

function makeOutline(order: number): SceneOutline {
  return {
    id: `outline-${order}`,
    type: 'slide',
    title: 't',
    description: 'd',
    keyPoints: [],
    order,
  };
}

const ownerMeta = (generationComplete: boolean) => ({
  isOwner: true,
  isPublic: false,
  publishedAt: null,
  generationComplete,
});

const storeState = () => {
  const state = useStageStore.getState();
  return {
    stageId: state.stage?.id,
    generationComplete: state.generationComplete,
    outlineProducer: state.outlineProducer,
  };
};

async function reopen(document: {
  complete: boolean | undefined;
  producer?: 'client' | 'server-job';
}) {
  useStageStore.getState().clearStore();
  mocks.loadStageData.mockResolvedValue({
    stage: makeStage(),
    scenes: [makeScene(1)],
    currentSceneId: 'scene-1',
    chats: [],
    outline: {
      outlines: [makeOutline(1)],
      generationComplete: document.complete,
      producer: document.producer,
      createdAt: 1,
      updatedAt: 1,
    },
  });
  await useStageStore.getState().loadFromStorage('stage-f');
}

beforeEach(() => {
  vi.clearAllMocks();
  resetForegroundCompletionCompensationForTests();
  mocks.saveStageData.mockResolvedValue(undefined);
  mocks.complete.mockResolvedValue(undefined);
  useStageStore.getState().clearStore();
});

describe('foreground completion fault positions', () => {
  it('(1) final save fails: no completion request, nothing claims completion', async () => {
    mocks.saveStageData.mockRejectedValue(new Error('quota exceeded'));
    useStageStore.setState({
      stage: makeStage(),
      scenes: [makeScene(1)],
      outlines: [makeOutline(1)],
    });
    useStageStore.getState().setGenerationComplete(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.toastWarning).not.toHaveBeenCalled();
  });

  it('(2) save lands, completion exhausts retries: visible warning, then reopen repairs it', async () => {
    mocks.complete.mockRejectedValueOnce(new ForegroundCompletionError(500, false));
    useStageStore.setState({
      stage: makeStage(),
      scenes: [makeScene(1)],
      outlines: [makeOutline(1)],
    });
    useStageStore.getState().setGenerationComplete(true);
    await vi.waitFor(() => expect(mocks.toastWarning).toHaveBeenCalledTimes(1));
    expect(mocks.complete).toHaveBeenCalledWith('stage-f');

    // (4) Reopen: the document is complete, the mirror still false.
    await reopen({ complete: true, producer: 'client' });
    const sent = await compensateForegroundCompletion('stage-f', ownerMeta(false), storeState, {
      persistenceEnabled: () => true,
      awaitSelfHealSave: awaitStageSelfHealSave,
      hasPendingSession: () => true,
    });
    expect(sent).toBe(true);
    expect(mocks.complete).toHaveBeenCalledTimes(2);
  });

  it('(3) completion landed but the response was lost: reopen re-sends while the session is held', async () => {
    // The mirror already reads true; only the retained session proves the
    // release may not have happened.
    await reopen({ complete: true, producer: 'client' });
    const sent = await compensateForegroundCompletion('stage-f', ownerMeta(true), storeState, {
      persistenceEnabled: () => true,
      awaitSelfHealSave: awaitStageSelfHealSave,
      hasPendingSession: () => true,
    });
    expect(sent).toBe(true);
    expect(mocks.complete).toHaveBeenCalledTimes(1);
    // Repair is the narrow completion request only; it never rewrites the document.
    expect(mocks.saveStageData).not.toHaveBeenCalled();
  });

  it('does not warn for a course deleted before completion (404)', async () => {
    mocks.complete.mockRejectedValueOnce(new ForegroundCompletionError(404, true));
    useStageStore.setState({
      stage: makeStage(),
      scenes: [makeScene(1)],
      outlines: [makeOutline(1)],
    });
    useStageStore.getState().setGenerationComplete(true);
    await vi.waitFor(() => expect(mocks.complete).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mocks.toastWarning).not.toHaveBeenCalled();
  });

  it('reopening a legacy finished deck waits for its self-heal save before repairing', async () => {
    let finishSave: () => void = () => undefined;
    mocks.saveStageData.mockImplementation(
      () => new Promise<void>((resolve) => (finishSave = resolve)),
    );
    await reopen({ complete: undefined, producer: 'client' });
    expect(useStageStore.getState().generationComplete).toBe(true);

    const pending = compensateForegroundCompletion('stage-f', ownerMeta(false), storeState, {
      persistenceEnabled: () => true,
      awaitSelfHealSave: awaitStageSelfHealSave,
      hasPendingSession: () => false,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mocks.complete).not.toHaveBeenCalled();
    finishSave();
    await expect(pending).resolves.toBe(true);
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  });

  it('never repairs a server-job (Pro/PPTX) course on reopen', async () => {
    await reopen({ complete: true, producer: 'server-job' });
    const sent = await compensateForegroundCompletion('stage-f', ownerMeta(false), storeState, {
      persistenceEnabled: () => true,
      awaitSelfHealSave: awaitStageSelfHealSave,
      hasPendingSession: () => true,
    });
    expect(sent).toBe(false);
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('never marks an unfinished course complete on reopen', async () => {
    useStageStore.getState().clearStore();
    mocks.loadStageData.mockResolvedValue({
      stage: makeStage(),
      scenes: [makeScene(1)],
      currentSceneId: 'scene-1',
      chats: [],
      outline: {
        outlines: [makeOutline(1), makeOutline(2)],
        generationComplete: false,
        producer: 'client',
        createdAt: 1,
        updatedAt: 1,
      },
    });
    await useStageStore.getState().loadFromStorage('stage-f');
    const sent = await compensateForegroundCompletion('stage-f', ownerMeta(false), storeState, {
      persistenceEnabled: () => true,
      awaitSelfHealSave: awaitStageSelfHealSave,
      hasPendingSession: () => true,
    });
    expect(sent).toBe(false);
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});
