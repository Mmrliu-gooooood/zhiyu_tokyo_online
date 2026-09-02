// @vitest-environment jsdom

import {
  act,
  createElement,
  Profiler,
  StrictMode,
  useSyncExternalStore,
  version as reactVersion,
  type ProfilerOnRenderCallback,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { version as reactDomVersion } from 'react-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createReactProfilerRecorder } from './react-profiler-recorder';

const EVENT_COUNT = 100;
const PHASE0_ROOT_P95_MS = {
  speech: 5.643,
  thinking: 2.165,
} as const;
const PROFILER_IDS = [
  'PlaybackChromeRoot',
  'ClassroomShellSubtree',
  'Header',
  'SceneRail',
  'StageRuntime',
  'InteractionPanel',
  'PlaybackBar',
] as const;

// These child boundaries stay controlled so the 100-event sequence is deterministic.
// Their render cost is deliberately absent: duration is comparable only against a later
// run of this identical component-seam harness, never against the product browser surface.
const EXCLUDED_CHILD_SUBTREES = [
  'HeaderControls',
  'SceneThumbnailContent',
  'CanvasToolbar',
  'CanvasArea',
  'Roundtable',
  'ChatArea',
] as const;

const mocks = vi.hoisted(() => ({
  onRender: undefined as ProfilerOnRenderCallback | undefined,
  captureChatAreaProps: vi.fn(),
  capturePlaybackBarProps: vi.fn(),
  captureRoundtableProps: vi.fn(),
  captureShellRender: vi.fn(),
  setWhiteboardOpenManually: vi.fn(),
  engineOptions: undefined as Record<string, unknown> | undefined,
  loadCursor: vi.fn(),
  activeSessionId: 'session-current' as string | null,
}));

const scene = {
  id: 'scene-1',
  stageId: 'stage-1',
  title: 'Profiler scene',
  order: 0,
  type: 'slide',
  actions: [{ id: 'speech-1', type: 'speech', text: 'Baseline speech.' }],
  content: { type: 'slide', canvas: { elements: [] } },
};
const secondScene = { ...scene, id: 'scene-2', title: 'Second profiler scene', order: 1 };

const stageState = {
  mode: 'playback',
  stage: { id: 'stage-1', name: 'Profiler course', whiteboard: [] },
  getCurrentScene: () => scene,
  scenes: [scene, secondScene],
  currentSceneId: scene.id,
  toolbarState: 'design',
  setCurrentSceneId: vi.fn(),
  generatingOutlines: [],
  outlines: [],
  generationStatus: 'idle',
};
const stageListeners = new Set<() => void>();

vi.mock('@/lib/store', () => {
  const useStageStore = Object.assign(
    (selector: (state: typeof stageState) => unknown = (state) => state) =>
      useSyncExternalStore(
        (listener) => {
          stageListeners.add(listener);
          return () => stageListeners.delete(listener);
        },
        () => selector(stageState),
        () => selector(stageState),
      ),
    {
      use: {
        failedOutlines: () => [],
        generationComplete: () => true,
      },
      getState: () => stageState,
      setState: (partial: Partial<typeof stageState>) => {
        Object.assign(stageState, partial);
        for (const listener of stageListeners) listener();
      },
    },
  );
  const useCanvasStore = {
    use: {
      viewportSize: () => 1000,
      viewportRatio: () => 0.5625,
    },
  };
  return { useStageStore, useCanvasStore };
});

vi.mock('@/lib/store/canvas', () => ({
  useCanvasStore: {
    use: {
      whiteboardOpen: () => false,
      setWhiteboardOpenManually: () => mocks.setWhiteboardOpenManually,
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
  setPlaybackSpeed: vi.fn(),
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
  PLAYBACK_SPEEDS: [0.5, 1, 1.5, 2],
}));

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/components/stage/header-controls', () => ({ HeaderControls: () => null }));
vi.mock('@/components/stage/scene-thumbnail-content', () => ({
  SceneThumbnailContent: () => null,
}));
vi.mock('@/components/canvas/canvas-toolbar', () => ({ CanvasToolbar: () => null }));

vi.mock('@/components/classroom/ZhiyuClassroomShell', async (importOriginal) => {
  const React = await import('react');
  const actual =
    await importOriginal<typeof import('@/components/classroom/ZhiyuClassroomShell')>();
  return {
    ...actual,
    ZhiyuClassroomShell: (props: Parameters<typeof actual.ZhiyuClassroomShell>[0]) => {
      mocks.captureShellRender();
      return React.createElement(
        React.Profiler,
        { id: 'ClassroomShellSubtree', onRender: (...args) => mocks.onRender?.(...args) },
        React.createElement(actual.ZhiyuClassroomShell, props),
      );
    },
  };
});

vi.mock('@/components/header', async (importOriginal) => {
  const React = await import('react');
  const actual = await importOriginal<typeof import('@/components/header')>();
  return {
    ...actual,
    Header: (props: Parameters<typeof actual.Header>[0]) =>
      React.createElement(
        React.Profiler,
        { id: 'Header', onRender: (...args) => mocks.onRender?.(...args) },
        React.createElement(actual.Header, props),
      ),
  };
});

vi.mock('@/components/stage/scene-sidebar', async (importOriginal) => {
  const React = await import('react');
  const actual = await importOriginal<typeof import('@/components/stage/scene-sidebar')>();
  return {
    ...actual,
    SceneSidebar: (props: Parameters<typeof actual.SceneSidebar>[0]) =>
      React.createElement(
        React.Profiler,
        { id: 'SceneRail', onRender: (...args) => mocks.onRender?.(...args) },
        React.createElement(actual.SceneSidebar, props),
      ),
  };
});

vi.mock('@/components/classroom/ZhiyuInteractionPanel', async (importOriginal) => {
  const React = await import('react');
  const actual =
    await importOriginal<typeof import('@/components/classroom/ZhiyuInteractionPanel')>();
  return {
    ...actual,
    ZhiyuInteractionPanel: (props: Parameters<typeof actual.ZhiyuInteractionPanel>[0]) =>
      React.createElement(
        React.Profiler,
        { id: 'InteractionPanel', onRender: (...args) => mocks.onRender?.(...args) },
        React.createElement(actual.ZhiyuInteractionPanel, props),
      ),
  };
});

vi.mock('@/components/classroom/ZhiyuPlaybackBar', async (importOriginal) => {
  const React = await import('react');
  const actual = await importOriginal<typeof import('@/components/classroom/ZhiyuPlaybackBar')>();
  return {
    ...actual,
    ZhiyuPlaybackBar: (props: Parameters<typeof actual.ZhiyuPlaybackBar>[0]) => {
      mocks.capturePlaybackBarProps(props);
      return React.createElement(
        React.Profiler,
        { id: 'PlaybackBar', onRender: (...args) => mocks.onRender?.(...args) },
        React.createElement(actual.ZhiyuPlaybackBar, props),
      );
    },
  };
});

vi.mock('@/components/canvas/canvas-area', () => ({ CanvasArea: () => null }));
vi.mock('@/components/roundtable', () => ({
  Roundtable: (props: Record<string, unknown>) => {
    mocks.captureRoundtableProps(props);
    return createElement(Profiler, {
      id: 'StageRuntime',
      onRender: (...args) => mocks.onRender?.(...args),
    });
  },
}));

vi.mock('@/components/chat/chat-area', async () => {
  const React = await import('react');
  return {
    ChatArea: React.forwardRef(function ProfilerChatArea(props: Record<string, unknown>, ref) {
      mocks.captureChatAreaProps(props);
      React.useImperativeHandle(ref, () => ({
        sendMessage: vi.fn().mockResolvedValue(undefined),
        endActiveSession: vi.fn().mockResolvedValue(undefined),
        endSession: vi.fn().mockResolvedValue(undefined),
        startLecture: vi.fn().mockResolvedValue('lecture-1'),
        addLectureMessage: vi.fn(),
        getLectureMessageId: vi.fn(),
        startDiscussion: vi.fn(),
        switchToTab: vi.fn(),
        resumeActiveLiveBuffer: vi.fn(),
        pauseActiveLiveBuffer: vi.fn(),
        stopActiveSession: vi.fn(),
        continueActiveSoftClosingSession: vi.fn(),
        getActiveSessionType: vi.fn(() => null),
        getActiveSessionId: vi.fn(() => mocks.activeSessionId),
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
      options: Record<string, unknown>,
    ) {
      mocks.engineOptions = options;
      (options.onModeChange as ((mode: string) => void) | undefined)?.('idle');
    }
    stop() {}
    getMode() {
      return 'idle';
    }
    isExhausted() {
      return false;
    }
    canJumpToAction() {
      return false;
    }
    async jumpToAction() {
      return false;
    }
    handleUserInterrupt() {}
    start() {}
    continuePlayback() {}
    pause() {}
    confirmDiscussion() {}
    skipDiscussion() {}
  },
  computePlaybackView: () => ({ kind: 'idle', isTopicActive: false }),
  shouldAutoResumeLecture: () => false,
}));

vi.mock('@/lib/playback/action-navigation', () => ({
  canJumpWithinReconstructablePrefix: () => false,
  isUnsafePlaybackNavigationAction: () => false,
}));
vi.mock('@/lib/playback/action-resume', () => ({
  getActionResumeRestoreCursor: () => ({ actionIndex: 0, position: null }),
  clearActionResumePosition: vi.fn(),
  createActionResumePosition: vi.fn(),
  getActionResumeStorageKey: () => 'profiler-resume-key',
  readActionResumeState: () => null,
  saveActionResumePosition: vi.fn(),
}));
vi.mock('@/lib/playback/cursor', () => ({
  loadCursor: mocks.loadCursor,
  saveCursor: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/action/engine', () => ({ ActionEngine: class {} }));
vi.mock('@/lib/utils/audio-player', () => ({
  createAudioPlayer: () => ({
    destroy: vi.fn(),
    setMuted: vi.fn(),
    setVolume: vi.fn(),
    setPlaybackRate: vi.fn(),
  }),
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
vi.mock('@/lib/config/feature-flags', () => ({ isPiChatEnabled: () => true }));

import { PlaybackChromeRoot } from '@/components/edit/PlaybackChromeRoot';
import { useStageStore } from '@/lib/store';

type SpeechProgress = (ratio: number | null) => void;
type ThinkingUpdate = (state: { stage: string; agentId?: string } | null) => void;

async function publish(update: () => void): Promise<void> {
  await act(async () => {
    update();
    await Promise.resolve();
  });
}

describe('Phase 0 PlaybackChromeRoot synthetic component-seam Profiler evidence', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalInnerWidthDescriptor: PropertyDescriptor;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const descriptor = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    if (!descriptor) throw new Error('jsdom window.innerWidth must be an own property');
    originalInnerWidthDescriptor = descriptor;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1366 });
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches:
        (query.includes('max-width: 1279px') && window.innerWidth <= 1279) ||
        (query.includes('max-width: 899px') && window.innerWidth <= 899),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    mocks.captureChatAreaProps.mockClear();
    mocks.capturePlaybackBarProps.mockClear();
    mocks.captureRoundtableProps.mockClear();
    mocks.captureShellRender.mockClear();
    mocks.engineOptions = undefined;
    mocks.loadCursor.mockReset();
    mocks.loadCursor.mockResolvedValue(null);
    mocks.activeSessionId = 'session-current';
    stageListeners.clear();
    stageState.currentSceneId = scene.id;
    stageState.toolbarState = 'design';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    mocks.onRender = undefined;
    container.remove();
    Object.defineProperty(window, 'innerWidth', originalInnerWidthDescriptor);
    vi.unstubAllGlobals();
  });

  it('records 100 speech-progress and 100 thinking updates at synthetic component seams', async () => {
    const recorder = createReactProfilerRecorder();
    mocks.onRender = recorder.onRender;
    await act(async () => {
      root.render(
        createElement(
          Profiler,
          { id: 'PlaybackChromeRoot', onRender: recorder.onRender },
          createElement(PlaybackChromeRoot),
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const chatAreaProps = mocks.captureChatAreaProps.mock.lastCall?.[0] as
      | Record<string, unknown>
      | undefined;
    const speechProgress = chatAreaProps?.onSpeechProgress as SpeechProgress | undefined;
    const thinkingUpdate = chatAreaProps?.onThinking as ThinkingUpdate | undefined;
    expect(speechProgress).toBeTypeOf('function');
    expect(thinkingUpdate).toBeTypeOf('function');

    await publish(() => speechProgress?.(0));
    recorder.reset();
    mocks.captureShellRender.mockClear();
    for (let index = 1; index <= EVENT_COUNT; index += 1) {
      await publish(() => speechProgress?.(index / EVENT_COUNT));
    }
    const speech = recorder.report('speech-progress-100', EVENT_COUNT, PROFILER_IDS);
    const speechShellRenders = mocks.captureShellRender.mock.calls.length;

    await publish(() => thinkingUpdate?.({ stage: 'director' }));
    recorder.reset();
    mocks.captureShellRender.mockClear();
    for (let index = 0; index < EVENT_COUNT; index += 1) {
      await publish(() =>
        thinkingUpdate?.({
          stage: index % 2 === 0 ? 'director' : 'agent_loading',
          ...(index % 2 === 0 ? {} : { agentId: `agent-${index % 3}` }),
        }),
      );
    }
    const thinking = recorder.report('thinking-100', EVENT_COUNT, PROFILER_IDS);
    const thinkingShellRenders = mocks.captureShellRender.mock.calls.length;

    for (const scenario of [speech, thinking]) {
      expect(scenario.islands.Header?.commits).toBeLessThanOrEqual(5);
      expect(scenario.islands.SceneRail?.commits).toBeLessThanOrEqual(5);
    }
    expect(speechShellRenders).toBeLessThanOrEqual(5);
    expect(thinkingShellRenders).toBeLessThanOrEqual(5);
    expect(speech.islands.ClassroomShellSubtree?.commits).toBe(EVENT_COUNT);
    expect(thinking.islands.ClassroomShellSubtree?.commits).toBe(EVENT_COUNT);
    expect(speech.islands.SceneRail?.commits).toBe(0);
    expect(speech.islands.StageRuntime?.commits).toBe(EVENT_COUNT);
    expect(speech.islands.InteractionPanel?.commits).toBe(0);
    expect(speech.islands.PlaybackBar?.commits).toBe(0);
    expect(thinking.islands.StageRuntime?.commits).toBe(EVENT_COUNT);
    expect(thinking.islands.InteractionPanel?.commits).toBe(EVENT_COUNT);
    expect(thinking.islands.PlaybackBar?.commits).toBe(0);
    expect(speech.islands.PlaybackChromeRoot?.p95Ms).toBeLessThanOrEqual(
      PHASE0_ROOT_P95_MS.speech * 0.7,
    );
    expect(thinking.islands.PlaybackChromeRoot?.p95Ms).toBeLessThanOrEqual(
      PHASE0_ROOT_P95_MS.thinking * 0.7,
    );

    if (process.env.PHASE0_PROFILER_REPORT === '1') {
      process.stdout.write(
        `ZHIYU_PHASE0_PROFILER ${JSON.stringify({
          schemaVersion: 1,
          baselineKind: 'synthetic-component-seam',
          durationScope: 'profiled-components-excluding-listed-mocked-child-subtrees',
          comparisonConstraint: 'relative-only-with-identical-harness',
          profiledSeams: PROFILER_IDS,
          excludedChildSubtrees: EXCLUDED_CHILD_SUBTREES,
          runtime: {
            node: process.version,
            react: reactVersion,
            reactDom: reactDomVersion,
            platform: process.platform,
            arch: process.arch,
          },
          mode: 'vitest-jsdom-development-react',
          strictMode: false,
          syntheticViewport: 1366,
          eventSequenceVersion: 1,
          scenarios: [speech, thinking],
        })}\n`,
      );
    }
  });

  it('keeps low-frequency playback control callbacks stable during speech updates', async () => {
    await act(async () => {
      root.render(createElement(PlaybackChromeRoot));
      await Promise.resolve();
      await Promise.resolve();
    });

    const initialChatProps = mocks.captureChatAreaProps.mock.lastCall?.[0] as
      | Record<string, unknown>
      | undefined;
    const initialBarProps = mocks.capturePlaybackBarProps.mock.lastCall?.[0] as
      | Record<string, unknown>
      | undefined;
    const speechProgress = initialChatProps?.onSpeechProgress as SpeechProgress | undefined;
    expect(speechProgress).toBeTypeOf('function');

    await publish(() => speechProgress?.(0.5));

    const updatedBarProps = mocks.capturePlaybackBarProps.mock.lastCall?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(updatedBarProps?.onWhiteboardClose).toBe(initialBarProps?.onWhiteboardClose);
    expect(updatedBarProps?.onToggleMute).toBe(initialBarProps?.onToggleMute);
    expect(updatedBarProps?.onToggleAutoPlay).toBe(initialBarProps?.onToggleAutoPlay);
    expect(updatedBarProps?.onCycleSpeed).toBe(initialBarProps?.onCycleSpeed);
  });

  it('keeps Header and Scene Rail stable during engine control updates', async () => {
    const recorder = createReactProfilerRecorder();
    mocks.onRender = recorder.onRender;
    await act(async () => {
      root.render(createElement(PlaybackChromeRoot));
      await Promise.resolve();
      await Promise.resolve();
    });
    recorder.reset();

    await act(async () => {
      (mocks.engineOptions?.onModeChange as ((mode: string) => void) | undefined)?.('playing');
      await Promise.resolve();
    });

    const report = recorder.report('engine-mode-update', 1, ['Header', 'SceneRail']);
    expect(report.islands.Header?.commits).toBe(0);
    expect(report.islands.SceneRail?.commits).toBe(0);
  });

  it('keeps the mount-scoped runtime active after Strict Mode effect replay', async () => {
    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(PlaybackChromeRoot)));
      await Promise.resolve();
      await Promise.resolve();
    });

    const chatAreaProps = mocks.captureChatAreaProps.mock.lastCall?.[0] as
      | Record<string, unknown>
      | undefined;
    const thinkingUpdate = chatAreaProps?.onThinking as ThinkingUpdate | undefined;
    expect(thinkingUpdate).toBeTypeOf('function');

    await publish(() => thinkingUpdate?.({ stage: 'director' }));

    expect(mocks.captureRoundtableProps.mock.lastCall?.[0]).toMatchObject({
      thinkingState: { stage: 'director' },
    });
  });

  it('rejects a live update emitted by a superseded session producer', async () => {
    await act(async () => {
      root.render(createElement(PlaybackChromeRoot));
      await Promise.resolve();
      await Promise.resolve();
    });

    const chatAreaProps = mocks.captureChatAreaProps.mock.lastCall?.[0] as
      | Record<string, unknown>
      | undefined;
    const thinkingUpdate = chatAreaProps?.onThinking as
      | ((state: { stage: string }, producerSessionId: string) => void)
      | undefined;
    expect(thinkingUpdate).toBeTypeOf('function');

    await publish(() => thinkingUpdate?.({ stage: 'stale' }, 'session-old'));

    expect(mocks.captureRoundtableProps.mock.lastCall?.[0]).toMatchObject({
      thinkingState: null,
    });
  });

  it('does not commit PlaybackChromeRoot for unrelated StageStore updates', async () => {
    const onRootRender = vi.fn();
    await act(async () => {
      root.render(
        createElement(
          Profiler,
          { id: 'PlaybackChromeRoot', onRender: onRootRender },
          createElement(PlaybackChromeRoot),
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    const settledCommits = onRootRender.mock.calls.length;

    await act(async () => useStageStore.setState({ toolbarState: 'ai' }));
    expect(onRootRender).toHaveBeenCalledTimes(settledCommits);

    await act(async () => useStageStore.setState({ currentSceneId: secondScene.id }));
    expect(onRootRender.mock.calls.length).toBeGreaterThan(settledCommits);
  });
});
