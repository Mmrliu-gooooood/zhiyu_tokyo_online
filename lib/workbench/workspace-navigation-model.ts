import {
  activateCourseTab,
  closeCourseTab,
  NO_COURSE_TABS,
  openCourseTab,
  openCourseTabs,
  restoreCourseTabs,
  samePanes,
  withCourse,
  withSession,
  type WorkspaceCourseTabs,
  type WorkspacePanes,
} from '@/lib/workbench/workspace-panes';

export interface WorkspaceNavigationModel {
  readonly panes: WorkspacePanes;
  readonly courseTabs: WorkspaceCourseTabs;
  readonly narrowFocus: 'chat' | 'classroom';
  readonly newConversationRequested: boolean;
}

export type WorkspaceNavigationIntent =
  | { readonly type: 'hydrate_course_tabs'; readonly remembered: WorkspaceCourseTabs | null }
  | { readonly type: 'restore_history'; readonly panes: WorkspacePanes }
  | { readonly type: 'open_course'; readonly courseId: string }
  | { readonly type: 'open_courses'; readonly courseIds: readonly string[] }
  | { readonly type: 'activate_course'; readonly courseId: string }
  | { readonly type: 'close_course'; readonly courseId: string }
  | { readonly type: 'open_session'; readonly sessionId: string }
  | { readonly type: 'close_session' }
  | { readonly type: 'go_home' }
  | { readonly type: 'new_conversation' }
  | { readonly type: 'focus_chat' }
  | { readonly type: 'focus_classroom' };

export function initialWorkspaceNavigationModel(panes: WorkspacePanes): WorkspaceNavigationModel {
  return {
    panes,
    courseTabs: restoreCourseTabs(null, panes.courseId),
    narrowFocus: 'classroom',
    newConversationRequested: false,
  };
}

/** Canonical, side-effect-free transition table for every Workspace navigation intent. */
export function reduceWorkspaceNavigation(
  current: WorkspaceNavigationModel,
  intent: WorkspaceNavigationIntent,
): WorkspaceNavigationModel {
  switch (intent.type) {
    case 'hydrate_course_tabs': {
      if (!current.panes.courseId) return current;
      const courseTabs = restoreCourseTabs(intent.remembered, current.panes.courseId);
      return courseTabs === current.courseTabs ? current : { ...current, courseTabs };
    }
    case 'restore_history': {
      const courseTabs = intent.panes.courseId
        ? restoreCourseTabs(current.courseTabs, intent.panes.courseId)
        : current.courseTabs.activeCourseId === null
          ? current.courseTabs
          : NO_COURSE_TABS;
      if (
        samePanes(current.panes, intent.panes) &&
        courseTabs === current.courseTabs &&
        !current.newConversationRequested
      ) {
        return current;
      }
      return {
        ...current,
        panes: intent.panes,
        courseTabs,
        newConversationRequested: false,
      };
    }
    case 'open_course': {
      const courseTabs = openCourseTab(current.courseTabs, intent.courseId);
      const panes = withCourse(current.panes, courseTabs.activeCourseId);
      if (courseTabs === current.courseTabs && panes === current.panes) return current;
      return { ...current, panes, courseTabs, narrowFocus: 'classroom' };
    }
    case 'open_courses': {
      const opened = openCourseTabs(current.courseTabs, intent.courseIds);
      const courseTabs = current.courseTabs.activeCourseId
        ? activateCourseTab(opened, current.courseTabs.activeCourseId)
        : opened;
      if (courseTabs === current.courseTabs) return current;
      const panes = current.courseTabs.activeCourseId
        ? current.panes
        : withCourse(current.panes, courseTabs.activeCourseId);
      return { ...current, panes, courseTabs, narrowFocus: 'classroom' };
    }
    case 'activate_course': {
      const courseTabs = activateCourseTab(current.courseTabs, intent.courseId);
      if (courseTabs === current.courseTabs) return current;
      return {
        ...current,
        courseTabs,
        panes: withCourse(current.panes, courseTabs.activeCourseId),
      };
    }
    case 'close_course': {
      const courseTabs = closeCourseTab(current.courseTabs, intent.courseId);
      if (courseTabs === current.courseTabs) return current;
      return {
        ...current,
        courseTabs,
        panes: withCourse(current.panes, courseTabs.activeCourseId),
      };
    }
    case 'open_session': {
      const panes = withSession(current.panes, intent.sessionId);
      if (panes === current.panes && !current.newConversationRequested) return current;
      return { ...current, panes, newConversationRequested: false };
    }
    case 'close_session': {
      const panes = withSession(current.panes, null);
      if (panes === current.panes && !current.newConversationRequested) return current;
      return { ...current, panes, newConversationRequested: false };
    }
    case 'go_home':
      return {
        ...current,
        panes: { sessionId: null, courseId: null },
        courseTabs: NO_COURSE_TABS,
        newConversationRequested: false,
      };
    case 'new_conversation':
      return {
        ...current,
        panes: { sessionId: null, courseId: current.panes.courseId },
        courseTabs: current.panes.courseId ? current.courseTabs : NO_COURSE_TABS,
        newConversationRequested: true,
      };
    case 'focus_chat':
      return current.narrowFocus === 'chat' ? current : { ...current, narrowFocus: 'chat' };
    case 'focus_classroom':
      return current.narrowFocus === 'classroom'
        ? current
        : { ...current, narrowFocus: 'classroom' };
  }
}
