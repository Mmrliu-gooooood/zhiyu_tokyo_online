// @vitest-environment jsdom

import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockAudioPlayer = {
  destroy: ReturnType<typeof vi.fn>;
  setMuted: ReturnType<typeof vi.fn>;
  setVolume: ReturnType<typeof vi.fn>;
  setPlaybackRate: ReturnType<typeof vi.fn>;
};

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  endActiveSession: vi.fn(),
  roundtableProps: undefined as Record<string, unknown> | undefined,
  canvasProps: undefined as Record<string, unknown> | undefined,
  piEnabled: true,
  topicActive: false,
  engineMode: 'idle' as 'idle' | 'playing' | 'paused',
  engineOptions: undefined as
    | {
        onModeChange?: (mode: 'idle' | 'playing' | 'paused') => void;
        onUserInterrupt?: (text: string) => void;
        onDiscussionEnd?: () => void;
        onComplete?: () => void;
      }
    | undefined,
  handleUserInterrupt: vi.fn(),
  loadCursor: vi.fn(),
  startLecture: vi.fn(),
  continuePlayback: vi.fn(),
  canJumpWithin: vi.fn(),
  canJumpToAction: vi.fn(),
  jumpToAction: vi.fn(),
  retainedAudioPlayers: [] as MockAudioPlayer[],
}));

const textElement = {
  id: 'text-1',
  type: 'text',
  content: '<p>First grounded fact</p>',
  defaultFontName: 'Arial',
  defaultColor: '#000',
  left: 0,
  top: 0,
  width: 100,
  height: 40,
  rotate: 0,
};
const shapeElement = {
  id: 'shape-1',
  type: 'shape',
  viewBox: [100, 100],
  path: 'M0 0',
  fixedRatio: false,
  fill: '#fff',
  left: 0,
  top: 0,
  width: 100,
  height: 40,
  rotate: 0,
};
const scene = {
  id: 'scene-1',
  stageId: 'stage-1',
  title: 'Slide',
  order: 0,
  type: 'slide',
  actions: [
    { id: 'speech-1', type: 'speech', text: 'First.' },
    { id: 'speech-2', type: 'speech', text: 'Second.' },
  ],
  content: {
    type: 'slide',
    canvas: { elements: [textElement, shapeElement] },
  },
};
const secondScene = {
  ...scene,
  id: 'scene-2',
  title: 'Second slide',
  order: 1,
};
const stageState = {
  mode: 'playback',
  stage: { id: 'stage-1', whiteboard: [] },
  getCurrentScene: () =>
    stageState.scenes.find((candidate) => candidate.id === stageState.currentSceneId),
  scenes: [scene, secondScene],
  currentSceneId: scene.id,
  setCurrentSceneId: vi.fn((sceneId: string) => {
    stageState.currentSceneId = sceneId;
  }),
  generatingOutlines: [],
  outlines: [],
};

vi.mock('@/lib/store', () => {
  const useStageStore = Object.assign(() => stageState, {
    use: {
      failedOutlines: () => [],
      generationComplete: () => true,
    },
    getState: () => stageState,
  });
  return { useStageStore };
});

vi.mock('@/lib/store/canvas', () => ({
  useCanvasStore: {
    use: {
      whiteboardOpen: () => false,
      setWhiteboardOpenManually: () => vi.fn(),
    },
    getState: () => ({ whiteboardOpen: false }),
  },
}));

const settingsState = {
  sidebarCollapsed: false,
  setSidebarCollapsed: vi.fn(),
  chatAreaWidth: 320,
  setChatAreaWidth: vi.fn(),
  chatAreaCollapsed: false,
  setChatAreaCollapsed: vi.fn(),
  setTTSMuted: vi.fn(),
  setTTSVolume: vi.fn(),
  selectedAgentIds: [],
  ttsMuted: false,
  ttsEnabled: false,
  ttsVolume: 1,
  playbackSpeed: 1,
  autoPlayLecture: false,
};
vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: Object.assign(
    (selector: (state: typeof settingsState) => unknown) => selector(settingsState),
    { getState: () => settingsState },
  ),
}));

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'chat.lectureNotes.pageLabel') return `Page ${options?.n}`;
      const summaries: Record<string, string> = {
        'chat.elementReference.summary.noText': 'No text',
        'chat.elementReference.summary.emptyContent': 'No content',
        'chat.elementReference.summary.code': 'Code',
        'chat.elementReference.summary.line': 'Line',
        'chat.elementReference.summary.imageMetadata': 'Image (metadata only)',
        'chat.elementReference.summary.videoMetadata': 'Video (metadata only)',
        'chat.elementReference.summary.audioMetadata': 'Audio (metadata only)',
        'edit.element.text': 'Text',
        'edit.element.image': 'Image',
        'edit.element.shape': 'Shape',
        'edit.element.line': 'Line',
        'edit.element.chart': 'Chart',
        'edit.element.table': 'Table',
        'edit.element.latex': 'Formula',
        'edit.element.video': 'Video',
        'edit.element.audio': 'Audio',
        'edit.element.code': 'Code',
      };
      return summaries[key] ?? key;
    },
  }),
}));

vi.mock('@/components/stage/scene-sidebar', () => ({ SceneSidebar: () => null }));
vi.mock('@/components/header', () => ({ Header: () => null }));
vi.mock('@/components/canvas/canvas-area', async () => {
  const React = await import('react');
  return {
    CanvasArea: (props: Record<string, unknown>) => {
      mocks.canvasProps = props;
      return React.createElement(
        'button',
        {
          type: 'button',
          'data-testid': 'pick-text',
          onClick: () =>
            (props.onPickElement as ((element: unknown) => void) | undefined)?.(textElement),
        },
        'pick text',
      );
    },
  };
});
vi.mock('@/components/roundtable', async () => {
  const React = await import('react');
  return {
    Roundtable: (props: Record<string, unknown>) => {
      mocks.roundtableProps = props;
      const pill = props.elementReferencePill as
        | { sceneLabel: string; displaySummary: string; elementType: string }
        | undefined;
      return React.createElement(
        'div',
        null,
        props.showElementReference
          ? React.createElement(
              'button',
              {
                type: 'button',
                'data-testid': 'toggle-pick',
                onClick: () => (props.onToggleElementPick as (() => void) | undefined)?.(),
              },
              'toggle pick',
            )
          : null,
        React.createElement(
          'button',
          {
            type: 'button',
            'data-testid': 'send',
            onClick: () =>
              (props.onMessageSend as ((message: string) => void) | undefined)?.('Explain this'),
          },
          'send',
        ),
        pill
          ? React.createElement(
              'div',
              { 'data-testid': 'owner-pill' },
              `${pill.sceneLabel} · ${pill.elementType} · ${pill.displaySummary}`,
            )
          : null,
      );
    },
  };
});
vi.mock('@/components/chat/chat-area', async () => {
  const React = await import('react');
  return {
    ChatArea: React.forwardRef(function MockChatArea(_props, ref) {
      React.useImperativeHandle(ref, () => ({
        sendMessage: mocks.sendMessage,
        endActiveSession: mocks.endActiveSession,
        endSession: vi.fn().mockResolvedValue(undefined),
        startLecture: mocks.startLecture,
        addLectureMessage: vi.fn(),
        getLectureMessageId: vi.fn(),
        startDiscussion: vi.fn(),
        switchToTab: vi.fn(),
        resumeActiveLiveBuffer: vi.fn(),
        pauseActiveLiveBuffer: vi.fn(),
        stopActiveSession: vi.fn(),
        continueActiveSoftClosingSession: vi.fn(),
        getActiveSessionType: vi.fn(),
        pauseBuffer: vi.fn(),
        resumeBuffer: vi.fn(),
        resumeActiveSession: vi.fn(),
      }));
      return null;
    }),
  };
});

vi.mock('@/lib/playback', () => ({
  PlaybackEngine: class {
    constructor(
      _scenes: unknown,
      _actionEngine: unknown,
      _audioPlayer: unknown,
      options: {
        onModeChange?: (mode: 'idle' | 'playing' | 'paused') => void;
        onUserInterrupt?: (text: string) => void;
        onDiscussionEnd?: () => void;
        onComplete?: () => void;
      },
    ) {
      mocks.engineOptions = options;
      mocks.retainedAudioPlayers.push(_audioPlayer as MockAudioPlayer);
      options.onModeChange?.(mocks.engineMode);
    }
    stop() {}
    getMode() {
      return mocks.engineMode;
    }
    isExhausted() {
      return false;
    }
    canJumpToAction() {
      return mocks.canJumpToAction();
    }
    jumpToAction() {
      return mocks.jumpToAction();
    }
    handleUserInterrupt(text: string) {
      mocks.handleUserInterrupt(text);
      mocks.engineOptions?.onUserInterrupt?.(text);
    }
    start() {}
    continuePlayback() {
      mocks.continuePlayback();
    }
    pause() {}
    confirmDiscussion() {}
    skipDiscussion() {}
  },
  computePlaybackView: () => ({ kind: 'idle', isTopicActive: mocks.topicActive }),
  shouldAutoResumeLecture: () => false,
}));
vi.mock('@/lib/playback/action-navigation', () => ({
  canJumpWithinReconstructablePrefix: mocks.canJumpWithin,
  isUnsafePlaybackNavigationAction: () => false,
}));
vi.mock('@/lib/playback/action-resume', () => ({
  getActionResumeRestoreCursor: () => ({ actionIndex: 0, position: null }),
  clearActionResumePosition: vi.fn(),
  createActionResumePosition: vi.fn(),
  getActionResumeStorageKey: () => 'resume-key',
  readActionResumeState: () => null,
  saveActionResumePosition: vi.fn(),
}));
vi.mock('@/lib/playback/cursor', () => ({
  loadCursor: mocks.loadCursor,
  saveCursor: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/action/engine', () => ({ ActionEngine: class {} }));
vi.mock('@/lib/utils/audio-player', () => ({
  createAudioPlayer: () => {
    const player = {
      destroy: vi.fn(),
      setMuted: vi.fn(),
      setVolume: vi.fn(),
      setPlaybackRate: vi.fn(),
    };
    return player;
  },
}));
vi.mock('@/lib/hooks/use-discussion-tts', () => ({
  useDiscussionTTS: () => ({
    cleanup: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    handleSegmentSealed: vi.fn(),
    shouldHold: vi.fn(() => false),
  }),
}));
vi.mock('@/lib/store/widget-iframe', () => ({
  useWidgetIframeStore: { getState: () => ({ getSendMessage: () => undefined }) },
}));
vi.mock('@/lib/orchestration/registry/store', () => ({
  agentsToParticipants: () => [],
  useAgentRegistry: Object.assign(
    (selector: (state: { agents: Record<string, unknown> }) => unknown) => selector({ agents: {} }),
    { getState: () => ({ getAgent: () => undefined }) },
  ),
}));
vi.mock('@/lib/config/feature-flags', () => ({ isPiChatEnabled: () => mocks.piEnabled }));

import {
  PlaybackChromeRoot,
  type PlaybackChromeRootHandle,
} from '@/components/edit/PlaybackChromeRoot';

describe('PlaybackChromeRoot element-reference ownership', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.sendMessage.mockReset();
    mocks.sendMessage.mockResolvedValue(undefined);
    mocks.endActiveSession.mockReset();
    mocks.endActiveSession.mockResolvedValue(undefined);
    mocks.roundtableProps = undefined;
    mocks.canvasProps = undefined;
    mocks.piEnabled = true;
    mocks.topicActive = false;
    mocks.engineMode = 'idle';
    mocks.engineOptions = undefined;
    mocks.handleUserInterrupt.mockReset();
    mocks.loadCursor.mockReset();
    mocks.loadCursor.mockResolvedValue(null);
    mocks.startLecture.mockReset();
    mocks.startLecture.mockResolvedValue('lecture-1');
    mocks.continuePlayback.mockReset();
    mocks.canJumpWithin.mockReset();
    mocks.canJumpWithin.mockReturnValue(false);
    mocks.canJumpToAction.mockReset();
    mocks.canJumpToAction.mockReturnValue(false);
    mocks.jumpToAction.mockReset();
    mocks.jumpToAction.mockResolvedValue(false);
    mocks.retainedAudioPlayers.length = 0;
    stageState.currentSceneId = scene.id;
    stageState.setCurrentSceneId.mockClear();
    settingsState.autoPlayLecture = false;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  function unmountOwner() {
    const mountedRoot = root;
    root = null;
    if (mountedRoot) act(() => mountedRoot.unmount());
  }

  afterEach(() => {
    unmountOwner();
    container.remove();
    vi.unstubAllGlobals();
  });

  function click(testId: string) {
    act(() => {
      container
        .querySelector(`[data-testid="${testId}"]`)!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  }

  async function renderOwner() {
    await act(async () => {
      root!.render(createElement(PlaybackChromeRoot));
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function rerenderOwner() {
    await act(async () => {
      root!.render(createElement(PlaybackChromeRoot));
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('releases owned global listeners and the retained audio player across 20 mount cycles', async () => {
    unmountOwner();
    container.remove();

    const mediaQueries: Array<{
      liveListeners: Set<EventListenerOrEventListenerObject>;
      addEventListener: ReturnType<typeof vi.fn>;
      removeEventListener: ReturnType<typeof vi.fn>;
    }> = [];
    vi.stubGlobal(
      'matchMedia',
      vi.fn((media: string) => {
        const liveListeners = new Set<EventListenerOrEventListenerObject>();
        const query = {
          matches: false,
          media,
          onchange: null,
          addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
            if (type === 'change') liveListeners.add(listener);
          }),
          removeEventListener: vi.fn(
            (type: string, listener: EventListenerOrEventListenerObject) => {
              if (type === 'change') liveListeners.delete(listener);
            },
          ),
          addListener: vi.fn(),
          removeListener: vi.fn(),
          dispatchEvent: vi.fn(() => true),
          liveListeners,
        };
        mediaQueries.push(query);
        return query;
      }),
    );

    const windowAddListenerSpy = vi.spyOn(window, 'addEventListener');
    const windowRemoveListenerSpy = vi.spyOn(window, 'removeEventListener');
    const documentAddListenerSpy = vi.spyOn(document, 'addEventListener');
    const documentRemoveListenerSpy = vi.spyOn(document, 'removeEventListener');
    const originalFullscreenElement = Object.getOwnPropertyDescriptor(
      document,
      'fullscreenElement',
    );
    let fullscreenElement: Element | null = null;
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => fullscreenElement,
    });
    const listenerBalance = (
      addSpy: typeof windowAddListenerSpy,
      removeSpy: typeof windowRemoveListenerSpy,
      type: string,
    ) =>
      addSpy.mock.calls.filter(([eventType]) => eventType === type).length -
      removeSpy.mock.calls.filter(([eventType]) => eventType === type).length;

    const activeListenerCounts: Array<[number, number, number, number, number, number]> = [];
    const postUnmountListenerCounts: Array<[number, number, number, number, number, number]> = [];
    let lifecycleRoot: Root | null = null;
    let lifecycleContainer: HTMLDivElement | null = null;
    try {
      for (let cycle = 0; cycle < 20; cycle += 1) {
        const retainedBeforeMount = mocks.retainedAudioPlayers.length;
        const mediaQueriesBeforeMount = mediaQueries.length;
        lifecycleContainer = document.createElement('div');
        document.body.appendChild(lifecycleContainer);
        const cycleRoot = createRoot(lifecycleContainer);
        lifecycleRoot = cycleRoot;
        await act(async () => {
          cycleRoot.render(createElement(PlaybackChromeRoot));
          await Promise.resolve();
          await Promise.resolve();
        });
        fullscreenElement = lifecycleContainer.firstElementChild;
        await act(async () => {
          document.dispatchEvent(new Event('fullscreenchange'));
          await Promise.resolve();
        });

        const retainedPlayers = mocks.retainedAudioPlayers.slice(retainedBeforeMount);
        const cycleMediaQueries = mediaQueries.slice(mediaQueriesBeforeMount);
        expect(retainedPlayers).toHaveLength(1);
        expect(retainedPlayers[0]?.destroy).not.toHaveBeenCalled();
        expect(cycleMediaQueries).toHaveLength(2);
        expect(cycleMediaQueries.map((query) => query.liveListeners.size)).toEqual([1, 1]);
        activeListenerCounts.push([
          listenerBalance(windowAddListenerSpy, windowRemoveListenerSpy, 'keydown'),
          listenerBalance(windowAddListenerSpy, windowRemoveListenerSpy, 'mousemove'),
          listenerBalance(windowAddListenerSpy, windowRemoveListenerSpy, 'mousedown'),
          listenerBalance(windowAddListenerSpy, windowRemoveListenerSpy, 'touchstart'),
          listenerBalance(documentAddListenerSpy, documentRemoveListenerSpy, 'fullscreenchange'),
          cycleMediaQueries.reduce((count, query) => count + query.liveListeners.size, 0),
        ]);

        act(() => cycleRoot.unmount());
        lifecycleRoot = null;
        lifecycleContainer.remove();
        lifecycleContainer = null;
        fullscreenElement = null;
        expect(retainedPlayers[0]?.destroy).toHaveBeenCalledTimes(1);
        expect(cycleMediaQueries.map((query) => query.liveListeners.size)).toEqual([0, 0]);
        postUnmountListenerCounts.push([
          listenerBalance(windowAddListenerSpy, windowRemoveListenerSpy, 'keydown'),
          listenerBalance(windowAddListenerSpy, windowRemoveListenerSpy, 'mousemove'),
          listenerBalance(windowAddListenerSpy, windowRemoveListenerSpy, 'mousedown'),
          listenerBalance(windowAddListenerSpy, windowRemoveListenerSpy, 'touchstart'),
          listenerBalance(documentAddListenerSpy, documentRemoveListenerSpy, 'fullscreenchange'),
          cycleMediaQueries.reduce((count, query) => count + query.liveListeners.size, 0),
        ]);
      }

      expect(activeListenerCounts).toEqual(Array(20).fill([2, 1, 1, 1, 1, 2]));
      expect(postUnmountListenerCounts).toEqual(Array(20).fill([0, 0, 0, 0, 0, 0]));
      expect(mocks.retainedAudioPlayers).toHaveLength(20);
      expect(
        mocks.retainedAudioPlayers.filter((player) => player.destroy.mock.calls.length === 1),
      ).toHaveLength(20);
      for (const eventType of ['keydown', 'mousemove', 'mousedown', 'touchstart']) {
        const added = windowAddListenerSpy.mock.calls
          .filter(([type]) => type === eventType)
          .map(([, listener]) => listener);
        const removed = windowRemoveListenerSpy.mock.calls
          .filter(([type]) => type === eventType)
          .map(([, listener]) => listener);
        expect(new Set(removed)).toEqual(new Set(added));
      }
      const addedFullscreenListeners = documentAddListenerSpy.mock.calls
        .filter(([type]) => type === 'fullscreenchange')
        .map(([, listener]) => listener);
      const removedFullscreenListeners = documentRemoveListenerSpy.mock.calls
        .filter(([type]) => type === 'fullscreenchange')
        .map(([, listener]) => listener);
      expect(new Set(removedFullscreenListeners)).toEqual(new Set(addedFullscreenListeners));
    } finally {
      if (lifecycleRoot) act(() => lifecycleRoot?.unmount());
      lifecycleContainer?.remove();
      fullscreenElement = null;
      if (originalFullscreenElement) {
        Object.defineProperty(document, 'fullscreenElement', originalFullscreenElement);
      } else {
        Reflect.deleteProperty(document, 'fullscreenElement');
      }
      windowAddListenerSpy.mockRestore();
      windowRemoveListenerSpy.mockRestore();
      documentAddListenerSpy.mockRestore();
      documentRemoveListenerSpy.mockRestore();
    }
  });

  it('releases repeated discussion end-flash timers across 20 mount cycles', async () => {
    vi.useFakeTimers();
    unmountOwner();
    container.remove();
    const timerBaseline = vi.getTimerCount();
    let lifecycleRoot: Root | null = null;
    let lifecycleContainer: HTMLDivElement | null = null;
    try {
      for (let cycle = 0; cycle < 20; cycle += 1) {
        lifecycleContainer = document.createElement('div');
        document.body.appendChild(lifecycleContainer);
        const cycleRoot = createRoot(lifecycleContainer);
        lifecycleRoot = cycleRoot;
        await act(async () => {
          cycleRoot.render(createElement(PlaybackChromeRoot));
          await Promise.resolve();
          await Promise.resolve();
        });

        act(() => {
          mocks.engineOptions?.onDiscussionEnd?.();
          mocks.engineOptions?.onDiscussionEnd?.();
        });
        expect(vi.getTimerCount()).toBe(timerBaseline + 1);

        act(() => cycleRoot.unmount());
        lifecycleRoot = null;
        lifecycleContainer.remove();
        lifecycleContainer = null;
        expect(vi.getTimerCount()).toBe(timerBaseline);
      }
    } finally {
      if (lifecycleRoot) act(() => lifecycleRoot?.unmount());
      lifecycleRoot = null;
      lifecycleContainer?.remove();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('cancels auto-advance timers and stale stage writes across 20 mount cycles', async () => {
    vi.useFakeTimers();
    settingsState.autoPlayLecture = true;
    unmountOwner();
    container.remove();
    const timerBaseline = vi.getTimerCount();
    const activeTimerDeltas: number[] = [];
    const postUnmountTimerDeltas: number[] = [];
    let lifecycleRoot: Root | null = null;
    let lifecycleContainer: HTMLDivElement | null = null;
    try {
      stageState.setCurrentSceneId.mockClear();
      for (let cycle = 0; cycle < 20; cycle += 1) {
        lifecycleContainer = document.createElement('div');
        document.body.appendChild(lifecycleContainer);
        const cycleRoot = createRoot(lifecycleContainer);
        lifecycleRoot = cycleRoot;
        await act(async () => {
          cycleRoot.render(createElement(PlaybackChromeRoot));
          await Promise.resolve();
          await Promise.resolve();
        });

        act(() => mocks.engineOptions?.onComplete?.());
        activeTimerDeltas.push(vi.getTimerCount() - timerBaseline);

        act(() => cycleRoot.unmount());
        lifecycleRoot = null;
        lifecycleContainer.remove();
        lifecycleContainer = null;
        postUnmountTimerDeltas.push(vi.getTimerCount() - timerBaseline);
      }

      await act(async () => vi.advanceTimersByTimeAsync(1500));
      expect.soft(activeTimerDeltas).toEqual(Array(20).fill(1));
      expect.soft(postUnmountTimerDeltas).toEqual(Array(20).fill(0));
      expect(stageState.setCurrentSceneId).not.toHaveBeenCalled();
    } finally {
      if (lifecycleRoot) act(() => lifecycleRoot?.unmount());
      lifecycleRoot = null;
      lifecycleContainer?.remove();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('cancels auto-advance before imperative teardown waits for session shutdown', async () => {
    vi.useFakeTimers();
    settingsState.autoPlayLecture = true;
    const playbackRef = createRef<PlaybackChromeRootHandle>();
    let resolveSessionEnd: (() => void) | undefined;
    let teardownPromise: Promise<void> | null = null;
    try {
      await act(async () => {
        root!.render(createElement(PlaybackChromeRoot, { ref: playbackRef }));
        await Promise.resolve();
        await Promise.resolve();
      });
      mocks.endActiveSession.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveSessionEnd = resolve;
          }),
      );
      const timerBaseline = vi.getTimerCount();
      act(() => mocks.engineOptions?.onComplete?.());
      expect(vi.getTimerCount()).toBe(timerBaseline + 1);

      stageState.setCurrentSceneId.mockClear();
      act(() => {
        teardownPromise = playbackRef.current!.teardown();
      });
      const timerCountWhileSessionEndIsPending = vi.getTimerCount();

      await act(async () => vi.advanceTimersByTimeAsync(1500));
      expect.soft(timerCountWhileSessionEndIsPending).toBe(timerBaseline);
      expect(stageState.setCurrentSceneId).not.toHaveBeenCalled();
    } finally {
      if (teardownPromise) {
        await act(async () => {
          resolveSessionEnd?.();
          await teardownPromise;
        });
      }
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('cancels a completed scene auto-advance across public scene navigation ABA', async () => {
    vi.useFakeTimers();
    settingsState.autoPlayLecture = true;
    try {
      await renderOwner();
      act(() => mocks.engineOptions?.onComplete?.());

      act(() => {
        (mocks.roundtableProps?.onNextSlide as (() => void) | undefined)?.();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(stageState.currentSceneId).toBe(secondScene.id);
      await rerenderOwner();

      act(() => {
        (mocks.roundtableProps?.onPrevSlide as (() => void) | undefined)?.();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(stageState.currentSceneId).toBe(scene.id);
      await rerenderOwner();
      stageState.setCurrentSceneId.mockClear();

      await act(async () => vi.advanceTimersByTimeAsync(1500));
      expect(stageState.setCurrentSceneId).not.toHaveBeenCalled();
      expect(stageState.currentSceneId).toBe(scene.id);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('owns pick state, freezes one request snapshot, and clears only on an accepted receipt', async () => {
    await renderOwner();

    click('toggle-pick');
    expect(mocks.canvasProps?.elementPickActive).toBe(true);
    click('pick-text');
    expect(container.querySelector('[data-testid="owner-pill"]')?.textContent).toContain(
      'Page 1 · Text · First grounded fact',
    );

    click('send');
    expect(mocks.sendMessage).toHaveBeenCalledOnce();
    const [, options] = mocks.sendMessage.mock.calls[0] as [
      string,
      { elementReference: unknown; onResponseAccepted: (response: Response) => void },
    ];
    expect(options.elementReference).toEqual({
      kind: 'slide_element',
      sceneId: 'scene-1',
      elementId: 'text-1',
    });
    act(() =>
      options.onResponseAccepted(
        new Response(null, { headers: { 'X-OpenMAIC-Element-Reference-Accepted': '1' } }),
      ),
    );
    expect(container.querySelector('[data-testid="owner-pill"]')).toBeNull();
  });

  it('consumes one Play intent after deferred cursor restore installs the engine', async () => {
    let resolveCursor!: (value: null) => void;
    mocks.loadCursor.mockImplementationOnce(
      () =>
        new Promise<null>((resolve) => {
          resolveCursor = resolve;
        }),
    );

    await renderOwner();
    act(() => {
      (mocks.canvasProps?.onPlayPause as (() => void) | undefined)?.();
    });
    expect(mocks.startLecture).not.toHaveBeenCalled();
    expect(mocks.continuePlayback).not.toHaveBeenCalled();

    await act(async () => {
      resolveCursor(null);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.continuePlayback).toHaveBeenCalledOnce();
  });

  it.each([true, false])(
    'queues Play while an installed engine restores its cursor with result %s',
    async (restoreResult) => {
      let resolveJump!: (value: boolean) => void;
      mocks.loadCursor.mockResolvedValueOnce({
        sceneId: scene.id,
        actionIndex: 1,
        updatedAt: '2026-09-02T00:00:00.000Z',
      });
      mocks.canJumpWithin.mockReturnValue(true);
      mocks.canJumpToAction.mockReturnValue(true);
      mocks.jumpToAction.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            resolveJump = resolve;
          }),
      );

      await renderOwner();
      expect(mocks.jumpToAction).toHaveBeenCalledOnce();
      act(() => {
        (mocks.canvasProps?.onPlayPause as (() => void) | undefined)?.();
      });
      expect(mocks.startLecture).not.toHaveBeenCalled();
      expect(mocks.continuePlayback).not.toHaveBeenCalled();

      await act(async () => {
        resolveJump(restoreResult);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mocks.continuePlayback).toHaveBeenCalledOnce();
    },
  );

  it('drops a stale queued Play when auto-start takes over the next scene', async () => {
    vi.useFakeTimers();
    settingsState.autoPlayLecture = true;
    let resolveJump!: (value: false) => void;
    mocks.loadCursor.mockResolvedValueOnce({
      sceneId: scene.id,
      actionIndex: 1,
      updatedAt: '2026-09-02T00:00:00.000Z',
    });
    mocks.canJumpWithin.mockReturnValue(true);
    mocks.canJumpToAction.mockReturnValue(true);
    mocks.jumpToAction.mockImplementationOnce(
      () =>
        new Promise<false>((resolve) => {
          resolveJump = resolve;
        }),
    );

    try {
      await renderOwner();
      act(() => {
        (mocks.canvasProps?.onPlayPause as (() => void) | undefined)?.();
        mocks.engineOptions?.onComplete?.();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      expect(stageState.currentSceneId).toBe(secondScene.id);

      await rerenderOwner();
      mocks.continuePlayback.mockClear();
      settingsState.autoPlayLecture = false;
      stageState.currentSceneId = scene.id;
      await rerenderOwner();

      expect(mocks.continuePlayback).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        resolveJump(false);
        await Promise.resolve();
      });
      vi.useRealTimers();
    }
  });

  it('queues Play for the new scene instead of operating the previous engine', async () => {
    await renderOwner();
    mocks.startLecture.mockClear();
    mocks.continuePlayback.mockClear();

    let resolveCursor!: (value: null) => void;
    mocks.loadCursor.mockImplementationOnce(
      () =>
        new Promise<null>((resolve) => {
          resolveCursor = resolve;
        }),
    );
    stageState.currentSceneId = secondScene.id;
    await rerenderOwner();

    act(() => {
      (mocks.canvasProps?.onPlayPause as (() => void) | undefined)?.();
    });
    expect(mocks.startLecture).not.toHaveBeenCalled();
    expect(mocks.continuePlayback).not.toHaveBeenCalled();

    await act(async () => {
      resolveCursor(null);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.startLecture).toHaveBeenCalledOnce();
    expect(mocks.continuePlayback).toHaveBeenCalledOnce();
  });

  it('does not let a cancelled scene initialization start its old engine', async () => {
    let resolveFirstCursor!: (value: null) => void;
    let resolveSecondCursor!: (value: null) => void;
    let resolveLecture!: (value: string) => void;
    mocks.loadCursor
      .mockImplementationOnce(
        () =>
          new Promise<null>((resolve) => {
            resolveFirstCursor = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<null>((resolve) => {
            resolveSecondCursor = resolve;
          }),
      );
    mocks.startLecture.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveLecture = resolve;
        }),
    );

    await renderOwner();
    act(() => {
      (mocks.canvasProps?.onPlayPause as (() => void) | undefined)?.();
    });
    await act(async () => {
      resolveFirstCursor(null);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.startLecture).toHaveBeenCalledOnce();

    stageState.currentSceneId = secondScene.id;
    await rerenderOwner();
    await act(async () => {
      resolveLecture('lecture-old');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.continuePlayback).not.toHaveBeenCalled();

    await act(async () => {
      resolveSecondCursor(null);
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it('keeps a newer owner draft when an older request receipt arrives', async () => {
    await renderOwner();
    click('toggle-pick');
    click('pick-text');
    click('send');
    const [, options] = mocks.sendMessage.mock.calls[0] as [
      string,
      { onResponseAccepted: (response: Response) => void },
    ];

    act(() => {
      (mocks.canvasProps?.onPickElement as (element: unknown) => void)(shapeElement);
    });
    act(() =>
      options.onResponseAccepted(
        new Response(null, { headers: { 'X-OpenMAIC-Element-Reference-Accepted': '1' } }),
      ),
    );

    expect(container.querySelector('[data-testid="owner-pill"]')?.textContent).toContain(
      'Page 1 · Shape · No text',
    );
  });

  it.each(['playing', 'paused'] as const)(
    'freezes the draft through the synchronous %s interrupt bridge and sends exactly once',
    async (mode) => {
      mocks.engineMode = mode;
      await renderOwner();
      expect(mocks.roundtableProps?.engineMode).toBe(mode);

      click('toggle-pick');
      click('pick-text');
      click('send');

      expect(mocks.handleUserInterrupt).toHaveBeenCalledOnce();
      expect(mocks.handleUserInterrupt).toHaveBeenCalledWith('Explain this');
      expect(mocks.sendMessage).toHaveBeenCalledOnce();
      expect(mocks.sendMessage).toHaveBeenCalledWith(
        'Explain this',
        expect.objectContaining({
          elementReference: {
            kind: 'slide_element',
            sceneId: 'scene-1',
            elementId: 'text-1',
          },
        }),
      );
    },
  );

  it('hides the entry and sends an ordinary unreferenced message when Pi is off', async () => {
    mocks.piEnabled = false;
    await renderOwner();

    expect(mocks.roundtableProps).toMatchObject({
      showElementReference: false,
      canPickSlideElement: false,
      elementPickActive: false,
    });
    expect(container.querySelector('[data-testid="toggle-pick"]')).toBeNull();

    click('send');

    expect(mocks.handleUserInterrupt).not.toHaveBeenCalled();
    expect(mocks.sendMessage).toHaveBeenCalledOnce();
    expect(mocks.sendMessage).toHaveBeenCalledWith('Explain this', undefined);
  });

  it('clears the owner draft after manual scene navigation settles', async () => {
    await renderOwner();
    click('toggle-pick');
    click('pick-text');
    expect(container.querySelector('[data-testid="owner-pill"]')).not.toBeNull();

    act(() => {
      (mocks.roundtableProps?.onNextSlide as (() => void) | undefined)?.();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(stageState.setCurrentSceneId).toHaveBeenCalledWith(secondScene.id);

    await rerenderOwner();
    expect(container.querySelector('[data-testid="owner-pill"]')).toBeNull();

    click('send');
    expect(mocks.sendMessage).toHaveBeenCalledWith('Explain this', undefined);
  });

  it('keeps the owner draft while a gated scene navigation has not settled', async () => {
    mocks.topicActive = true;
    await renderOwner();
    click('toggle-pick');
    click('pick-text');

    act(() => {
      (mocks.roundtableProps?.onNextSlide as (() => void) | undefined)?.();
    });

    expect(stageState.setCurrentSceneId).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="owner-pill"]')).not.toBeNull();
  });

  it('clears the owner draft after automatic playback advances the scene', async () => {
    vi.useFakeTimers();
    settingsState.autoPlayLecture = true;
    try {
      await renderOwner();
      click('toggle-pick');
      click('pick-text');
      expect(container.querySelector('[data-testid="owner-pill"]')).not.toBeNull();

      act(() => mocks.engineOptions?.onComplete?.());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      expect(stageState.setCurrentSceneId).toHaveBeenCalledWith(secondScene.id);

      await rerenderOwner();
      expect(container.querySelector('[data-testid="owner-pill"]')).toBeNull();

      click('send');
      expect(mocks.sendMessage).toHaveBeenCalledWith('Explain this', undefined);
    } finally {
      vi.useRealTimers();
    }
  });
});
