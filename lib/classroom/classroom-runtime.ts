export type ClassroomRuntimeState = {
  compactViewport: boolean;
  narrowViewport: boolean;
  compactInteractionOpen: boolean;
  narrowSceneRailOpen: boolean;
  isPresenting: boolean;
  isDiscussionPaused: boolean;
};

export type ClassroomThinkingState = {
  stage: string;
  agentId?: string;
} | null;

export type ClassroomLiveRuntimeState = {
  liveSpeech: string | null;
  speechProgress: number | null;
  thinkingState: ClassroomThinkingState;
};

export type ClassroomRuntimeEpoch = Readonly<{
  scene: number;
  session: number;
}>;

export type ClassroomLiveRuntime = {
  getState: () => ClassroomLiveRuntimeState;
  subscribe: (listener: () => void) => () => void;
  setLiveSpeech: (liveSpeech: string | null) => void;
  setSpeechProgress: (speechProgress: number | null) => void;
  setThinkingState: (thinkingState: ClassroomThinkingState) => void;
  reset: () => void;
  captureEpoch: () => ClassroomRuntimeEpoch;
  isCurrentEpoch: (epoch: ClassroomRuntimeEpoch) => boolean;
  advanceScene: () => void;
  advanceSession: () => void;
  activate: () => void;
  deactivate: () => void;
  dispose: () => void;
};

const createInitialClassroomLiveRuntimeState = (): ClassroomLiveRuntimeState => ({
  liveSpeech: null,
  speechProgress: null,
  thinkingState: null,
});

export function createClassroomLiveRuntime(): ClassroomLiveRuntime {
  let state = createInitialClassroomLiveRuntimeState();
  let sceneEpoch = 0;
  let sessionEpoch = 0;
  let active = true;
  let disposed = false;
  const listeners = new Set<() => void>();

  const update = (partial: Partial<ClassroomLiveRuntimeState>) => {
    if (!active || disposed) return;
    const next = { ...state, ...partial };
    if (
      next.liveSpeech === state.liveSpeech &&
      next.speechProgress === state.speechProgress &&
      next.thinkingState === state.thinkingState
    ) {
      return;
    }
    state = next;
    listeners.forEach((listener) => listener());
  };

  const reset = () => {
    if (
      state.liveSpeech === null &&
      state.speechProgress === null &&
      state.thinkingState === null
    ) {
      return;
    }
    state = createInitialClassroomLiveRuntimeState();
    listeners.forEach((listener) => listener());
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setLiveSpeech: (liveSpeech) => update({ liveSpeech }),
    setSpeechProgress: (speechProgress) => update({ speechProgress }),
    setThinkingState: (thinkingState) => update({ thinkingState }),
    reset,
    captureEpoch: () => ({ scene: sceneEpoch, session: sessionEpoch }),
    isCurrentEpoch: (epoch) =>
      active && !disposed && epoch.scene === sceneEpoch && epoch.session === sessionEpoch,
    advanceScene: () => {
      if (disposed) return;
      sceneEpoch += 1;
      sessionEpoch += 1;
      reset();
    },
    advanceSession: () => {
      if (disposed) return;
      sessionEpoch += 1;
      reset();
    },
    activate: () => {
      if (disposed || active) return;
      active = true;
    },
    deactivate: () => {
      if (disposed || !active) return;
      active = false;
      sceneEpoch += 1;
      sessionEpoch += 1;
      state = createInitialClassroomLiveRuntimeState();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      active = false;
      sceneEpoch += 1;
      sessionEpoch += 1;
      state = createInitialClassroomLiveRuntimeState();
      listeners.clear();
    },
  };
}

export type ClassroomRuntimeEvent =
  | {
      type: 'viewport.changed';
      compact: boolean;
      narrow: boolean;
    }
  | {
      type: 'interaction.presentationChanged';
      collapsed: boolean;
    }
  | {
      type: 'sceneRail.presentationChanged';
      collapsed: boolean;
    }
  | {
      type: 'presentation.changed';
      active: boolean;
    }
  | {
      type: 'discussion.pauseChanged';
      paused: boolean;
    }
  | { type: 'scene.switched' }
  | { type: 'session.cleaned' };

export function createInitialClassroomRuntimeState(): ClassroomRuntimeState {
  return {
    compactViewport: false,
    narrowViewport: false,
    compactInteractionOpen: false,
    narrowSceneRailOpen: false,
    isPresenting: false,
    isDiscussionPaused: false,
  };
}

export function reduceClassroomRuntime(
  state: ClassroomRuntimeState,
  event: ClassroomRuntimeEvent,
): ClassroomRuntimeState {
  switch (event.type) {
    case 'viewport.changed':
      return {
        ...state,
        compactViewport: event.compact,
        narrowViewport: event.narrow,
        compactInteractionOpen: event.compact ? state.compactInteractionOpen : false,
        narrowSceneRailOpen: event.narrow ? state.narrowSceneRailOpen : false,
      };
    case 'interaction.presentationChanged': {
      const open = state.compactViewport && !event.collapsed;
      return {
        ...state,
        compactInteractionOpen: open,
        narrowSceneRailOpen: open && state.narrowViewport ? false : state.narrowSceneRailOpen,
      };
    }
    case 'sceneRail.presentationChanged': {
      const open = state.narrowViewport && !event.collapsed;
      return {
        ...state,
        compactInteractionOpen:
          open && state.compactViewport ? false : state.compactInteractionOpen,
        narrowSceneRailOpen: open,
      };
    }
    case 'presentation.changed':
      return {
        ...state,
        isPresenting: event.active,
        compactInteractionOpen: event.active ? false : state.compactInteractionOpen,
        narrowSceneRailOpen: event.active ? false : state.narrowSceneRailOpen,
      };
    case 'discussion.pauseChanged':
      return state.isDiscussionPaused === event.paused
        ? state
        : { ...state, isDiscussionPaused: event.paused };
    case 'scene.switched':
      return state.isDiscussionPaused ? { ...state, isDiscussionPaused: false } : state;
    case 'session.cleaned': {
      const cleaned = {
        ...createInitialClassroomRuntimeState(),
        compactViewport: state.compactViewport,
        narrowViewport: state.narrowViewport,
      };
      return Object.entries(cleaned).every(
        ([key, value]) => state[key as keyof ClassroomRuntimeState] === value,
      )
        ? state
        : cleaned;
    }
  }
}
