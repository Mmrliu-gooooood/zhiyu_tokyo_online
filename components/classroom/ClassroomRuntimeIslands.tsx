'use client';

import { useSyncExternalStore, type ComponentProps, type ReactNode } from 'react';
import { Roundtable } from '@/components/roundtable';
import {
  ZhiyuInteractionPanel,
  type ZhiyuInteractionPanelProps,
} from '@/components/classroom/ZhiyuInteractionPanel';
import type { PlaybackView } from '@/lib/playback';
import type {
  ClassroomLiveRuntime,
  ClassroomLiveRuntimeState,
  ClassroomThinkingState,
} from '@/lib/classroom/classroom-runtime';
import type { ZhiyuClassroomLiveStatus } from '@/components/classroom/zhiyu-classroom-layout';

function useClassroomLiveRuntime(runtime: ClassroomLiveRuntime) {
  return useSyncExternalStore(runtime.subscribe, runtime.getState, runtime.getState);
}

function useClassroomThinkingState(runtime: ClassroomLiveRuntime) {
  return useSyncExternalStore(
    runtime.subscribe,
    () => runtime.getState().thinkingState,
    () => runtime.getState().thinkingState,
  );
}

type ClassroomRoundtableIslandProps = Omit<
  ComponentProps<typeof Roundtable>,
  'playbackView' | 'currentSpeech' | 'speechProgress' | 'thinkingState'
> & {
  readonly runtime: ClassroomLiveRuntime;
  readonly projectPlaybackView: (state: ClassroomLiveRuntimeState) => PlaybackView;
};

export function ClassroomRoundtableIsland({
  runtime,
  projectPlaybackView,
  ...props
}: ClassroomRoundtableIslandProps) {
  const live = useClassroomLiveRuntime(runtime);
  return (
    <Roundtable
      {...props}
      playbackView={projectPlaybackView(live)}
      currentSpeech={live.liveSpeech}
      speechProgress={live.speechProgress}
      thinkingState={live.thinkingState}
    />
  );
}

type ClassroomInteractionIslandProps = Omit<
  ZhiyuInteractionPanelProps,
  'liveStatus' | 'rolesContent'
> & {
  readonly runtime: ClassroomLiveRuntime;
  readonly projectLiveStatus: (thinking: boolean) => ZhiyuClassroomLiveStatus;
  readonly renderRolesContent: (thinkingState: ClassroomThinkingState) => ReactNode;
};

export function ClassroomInteractionIsland({
  runtime,
  projectLiveStatus,
  renderRolesContent,
  ...props
}: ClassroomInteractionIslandProps) {
  const thinkingState = useClassroomThinkingState(runtime);
  return (
    <ZhiyuInteractionPanel
      {...props}
      liveStatus={projectLiveStatus(Boolean(thinkingState))}
      rolesContent={renderRolesContent(thinkingState)}
    />
  );
}
