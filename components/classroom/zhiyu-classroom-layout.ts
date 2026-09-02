export const ZHIYU_SCENE_RAIL_COLLAPSED_WIDTH = 72;
export const ZHIYU_SCENE_RAIL_EXPANDED_WIDTH = 232;
export const ZHIYU_INTERACTION_PANEL_WIDTH = 340;

export type ZhiyuClassroomLayout = {
  readonly sceneRailWidth: number;
  readonly interactionPanelWidth: number;
};

export type ZhiyuClassroomLiveStatus = 'idle' | 'teaching' | 'thinking' | 'discussion';

const PRESENTATION_LAYOUT: ZhiyuClassroomLayout = Object.freeze({
  sceneRailWidth: 0,
  interactionPanelWidth: 0,
});

const CLASSROOM_LAYOUTS = {
  expandedExpanded: Object.freeze({
    sceneRailWidth: ZHIYU_SCENE_RAIL_EXPANDED_WIDTH,
    interactionPanelWidth: ZHIYU_INTERACTION_PANEL_WIDTH,
  }),
  expandedCollapsed: Object.freeze({
    sceneRailWidth: ZHIYU_SCENE_RAIL_EXPANDED_WIDTH,
    interactionPanelWidth: 0,
  }),
  collapsedExpanded: Object.freeze({
    sceneRailWidth: ZHIYU_SCENE_RAIL_COLLAPSED_WIDTH,
    interactionPanelWidth: ZHIYU_INTERACTION_PANEL_WIDTH,
  }),
  collapsedCollapsed: Object.freeze({
    sceneRailWidth: ZHIYU_SCENE_RAIL_COLLAPSED_WIDTH,
    interactionPanelWidth: 0,
  }),
} satisfies Record<string, ZhiyuClassroomLayout>;

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
  if (presenting) return PRESENTATION_LAYOUT;
  if (sceneRailCollapsed) {
    return interactionCollapsed
      ? CLASSROOM_LAYOUTS.collapsedCollapsed
      : CLASSROOM_LAYOUTS.collapsedExpanded;
  }
  return interactionCollapsed
    ? CLASSROOM_LAYOUTS.expandedCollapsed
    : CLASSROOM_LAYOUTS.expandedExpanded;
}
