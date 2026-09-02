import { describe, expect, it } from 'vitest';
import {
  projectZhiyuClassroomLayout,
  projectZhiyuClassroomLiveStatus,
  ZHIYU_INTERACTION_PANEL_WIDTH,
  ZHIYU_SCENE_RAIL_COLLAPSED_WIDTH,
  ZHIYU_SCENE_RAIL_EXPANDED_WIDTH,
} from '@/components/classroom/zhiyu-classroom-layout';

describe('projectZhiyuClassroomLayout', () => {
  it('projects the expanded desktop workspace without owning persisted state', () => {
    expect(
      projectZhiyuClassroomLayout({
        sceneRailCollapsed: false,
        interactionCollapsed: false,
      }),
    ).toEqual({
      sceneRailWidth: ZHIYU_SCENE_RAIL_EXPANDED_WIDTH,
      interactionPanelWidth: ZHIYU_INTERACTION_PANEL_WIDTH,
    });
  });

  it('keeps a compact scene rail while fully collapsing interaction', () => {
    expect(
      projectZhiyuClassroomLayout({
        sceneRailCollapsed: true,
        interactionCollapsed: true,
      }),
    ).toEqual({
      sceneRailWidth: ZHIYU_SCENE_RAIL_COLLAPSED_WIDTH,
      interactionPanelWidth: 0,
    });
  });

  it('fully hides both side regions for presentation mode', () => {
    expect(
      projectZhiyuClassroomLayout({
        sceneRailCollapsed: true,
        interactionCollapsed: true,
        presenting: true,
      }),
    ).toEqual({ sceneRailWidth: 0, interactionPanelWidth: 0 });
  });

  it('keeps the low-frequency layout projection referentially stable', () => {
    const first = projectZhiyuClassroomLayout({
      sceneRailCollapsed: false,
      interactionCollapsed: true,
    });
    const second = projectZhiyuClassroomLayout({
      sceneRailCollapsed: false,
      interactionCollapsed: true,
    });

    expect(second).toBe(first);
  });
});

describe('projectZhiyuClassroomLiveStatus', () => {
  it('projects only truthful existing playback and chat states', () => {
    expect(
      projectZhiyuClassroomLiveStatus({
        engineMode: 'playing',
        chatSessionType: null,
        thinking: false,
      }),
    ).toBe('teaching');
    expect(
      projectZhiyuClassroomLiveStatus({
        engineMode: 'live',
        chatSessionType: 'discussion',
        thinking: false,
      }),
    ).toBe('discussion');
    expect(
      projectZhiyuClassroomLiveStatus({
        engineMode: 'live',
        chatSessionType: 'discussion',
        thinking: true,
      }),
    ).toBe('thinking');
  });
});
