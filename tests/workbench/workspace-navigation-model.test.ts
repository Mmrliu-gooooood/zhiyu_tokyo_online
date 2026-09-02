import { describe, expect, it } from 'vitest';
import {
  initialWorkspaceNavigationModel,
  reduceWorkspaceNavigation,
} from '@/lib/workbench/workspace-navigation-model';

describe('Workspace canonical navigation transitions', () => {
  it('opens and closes course tabs while preserving the independent session pane', () => {
    const initial = initialWorkspaceNavigationModel({ sessionId: 'session-1', courseId: null });
    const opened = reduceWorkspaceNavigation(initial, {
      type: 'open_course',
      courseId: 'course-a',
    });
    const second = reduceWorkspaceNavigation(opened, { type: 'open_course', courseId: 'course-b' });
    const closed = reduceWorkspaceNavigation(second, {
      type: 'close_course',
      courseId: 'course-b',
    });

    expect(second).toMatchObject({
      panes: { sessionId: 'session-1', courseId: 'course-b' },
      courseTabs: { courseIds: ['course-a', 'course-b'], activeCourseId: 'course-b' },
      narrowFocus: 'classroom',
    });
    expect(closed).toMatchObject({
      panes: { sessionId: 'session-1', courseId: 'course-a' },
      courseTabs: {
        courseIds: ['course-a'],
        activeCourseId: 'course-a',
        closedCourseIds: ['course-b'],
      },
    });
  });

  it('keeps an explicit active course while adding a created-course batch', () => {
    const initial = reduceWorkspaceNavigation(
      initialWorkspaceNavigationModel({ sessionId: 'session-1', courseId: 'course-a' }),
      { type: 'hydrate_course_tabs', remembered: null },
    );
    const next = reduceWorkspaceNavigation(initial, {
      type: 'open_courses',
      courseIds: ['course-b', 'course-c'],
    });

    expect(next.courseTabs).toEqual({
      courseIds: ['course-a', 'course-b', 'course-c'],
      activeCourseId: 'course-a',
    });
    expect(next.panes.courseId).toBe('course-a');
  });

  it('treats browser history as authoritative without reviving remembered course tabs', () => {
    const opened = reduceWorkspaceNavigation(
      initialWorkspaceNavigationModel({ sessionId: 'session-1', courseId: 'course-a' }),
      { type: 'open_course', courseId: 'course-b' },
    );
    const home = reduceWorkspaceNavigation(opened, {
      type: 'restore_history',
      panes: { sessionId: null, courseId: null },
    });

    expect(home.panes).toEqual({ sessionId: null, courseId: null });
    expect(home.courseTabs.activeCourseId).toBeNull();
    expect(home.newConversationRequested).toBe(false);
  });

  it('starts a new conversation without closing the active classroom', () => {
    const initial = initialWorkspaceNavigationModel({
      sessionId: 'session-1',
      courseId: 'course-a',
    });
    const next = reduceWorkspaceNavigation(initial, { type: 'new_conversation' });

    expect(next.panes).toEqual({ sessionId: null, courseId: 'course-a' });
    expect(next.courseTabs.activeCourseId).toBe('course-a');
    expect(next.newConversationRequested).toBe(true);
  });

  it('moves narrow focus without changing URL-addressable panes', () => {
    const initial = initialWorkspaceNavigationModel({
      sessionId: 'session-1',
      courseId: 'course-a',
    });
    const chat = reduceWorkspaceNavigation(initial, { type: 'focus_chat' });
    const classroom = reduceWorkspaceNavigation(chat, { type: 'focus_classroom' });

    expect(chat.narrowFocus).toBe('chat');
    expect(classroom.narrowFocus).toBe('classroom');
    expect(classroom.panes).toBe(initial.panes);
  });
});
