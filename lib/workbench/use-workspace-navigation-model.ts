'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  initialWorkspaceNavigationModel,
  reduceWorkspaceNavigation,
  type WorkspaceNavigationIntent,
  type WorkspaceNavigationModel,
} from '@/lib/workbench/workspace-navigation-model';
import { readWorkspacePanes, samePanes, workspaceHref } from '@/lib/workbench/workspace-panes';
import { readCourseTabsMemory, writeCourseTabsMemory } from '@/lib/workbench/workspace-course-tabs';

export type WorkspaceNavigationWrite = 'push' | 'replace' | 'none';

export interface WorkspaceNavigationController extends WorkspaceNavigationModel {
  readonly transition: (
    intent: WorkspaceNavigationIntent,
    write?: WorkspaceNavigationWrite,
  ) => WorkspaceNavigationModel;
}

/** One mounted writer for URL panes, course-tab memory and narrow-view focus. */
export function useWorkspaceNavigationModel(
  initialPanes: WorkspaceNavigationModel['panes'],
): WorkspaceNavigationController {
  const [model, setModel] = useState(() => initialWorkspaceNavigationModel(initialPanes));
  const modelRef = useRef(model);

  const transition = useCallback(
    (intent: WorkspaceNavigationIntent, write: WorkspaceNavigationWrite = 'push') => {
      const current = modelRef.current;
      const next = reduceWorkspaceNavigation(current, intent);
      if (next === current) return current;
      modelRef.current = next;
      setModel(next);

      if (next.courseTabs !== current.courseTabs) writeCourseTabsMemory(next.courseTabs);
      if (write !== 'none' && !samePanes(next.panes, current.panes)) {
        const href = workspaceHref(next.panes);
        if (write === 'replace') window.history.replaceState(null, '', href);
        else window.history.pushState(null, '', href);
      }
      return next;
    },
    [],
  );

  useLayoutEffect(() => {
    if (!initialPanes.courseId) return;
    transition({ type: 'hydrate_course_tabs', remembered: readCourseTabsMemory() }, 'none');
  }, [initialPanes.courseId, transition]);

  useEffect(() => {
    const restoreFromHistory = () => {
      transition(
        {
          type: 'restore_history',
          panes: readWorkspacePanes(new URLSearchParams(window.location.search)),
        },
        'none',
      );
    };
    window.addEventListener('popstate', restoreFromHistory);
    return () => window.removeEventListener('popstate', restoreFromHistory);
  }, [transition]);

  return useMemo(() => ({ ...model, transition }), [model, transition]);
}
