export const ZHIYU_SCENE_RAIL_COLLAPSED_WIDTH = 72;
export const ZHIYU_SCENE_RAIL_EXPANDED_WIDTH = 232;
export const ZHIYU_INTERACTION_PANEL_WIDTH = 340;

export type ZhiyuClassroomLayout = {
  readonly sceneRailWidth: number;
  readonly interactionPanelWidth: number;
};

export type ZhiyuClassroomLiveStatus = 'idle' | 'teaching' | 'thinking' | 'discussion';

export function projectZhiyuClassroomLiveStatus({
  engineMode,
  chatSessionType,
  thinking,
}: {
  readonly engineMode: 'idle' | 'playing' | 'paused' | 'live';
  readonly chatSessionType: string | null;
  readonly thinking: boolean;
}): ZhiyuClassroomLiveStatus {
  if (thinking) return 'thinking';
  if (engineMode === 'live' || chatSessionType === 'qa' || chatSessionType === 'discussion') {
    return 'discussion';
  }
  return engineMode === 'playing' ? 'teaching' : 'idle';
}

/**
 * Pure projection for the two persisted classroom chrome toggles. The values
 * are presentation-only; ownership of the toggles stays in SettingsStore.
 */
export function projectZhiyuClassroomLayout({
  sceneRailCollapsed,
  interactionCollapsed,
  presenting = false,
}: {
  readonly sceneRailCollapsed: boolean;
  readonly interactionCollapsed: boolean;
  readonly presenting?: boolean;
}): ZhiyuClassroomLayout {
  if (presenting) {
    return { sceneRailWidth: 0, interactionPanelWidth: 0 };
  }
  return {
    sceneRailWidth: sceneRailCollapsed
      ? ZHIYU_SCENE_RAIL_COLLAPSED_WIDTH
      : ZHIYU_SCENE_RAIL_EXPANDED_WIDTH,
    interactionPanelWidth: interactionCollapsed ? 0 : ZHIYU_INTERACTION_PANEL_WIDTH,
  };
}
