'use client';

/**
 * What the app shell can offer the current visitor: which study sections this
 * deployment serves (and whether an account is signed in to use them), the
 * learner's active subject spaces for the sidebar, and the Ultra workbench
 * entry. Each probe is cached for the page session so moving between pages
 * that share the shell does not refetch it.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { peekAccountUserId } from '@/lib/auth/account-environment';
import { isProWorkbenchEnabled } from '@/lib/config/feature-flags';
import {
  fetchStudyCapabilities,
  studyApi,
  type StudyCapabilities,
} from '@/lib/study/spaces/client';
import type { StudySpaceSummary } from '@/lib/study/spaces/contracts';
import { startProSwap } from '@/lib/workbench/pro-swap';
import {
  readLastWorkspaceSessionId,
  workspaceResumeHref,
} from '@/lib/workbench/workspace-session-memory';

/** Dispatch after creating, renaming, archiving or deleting a space. */
export const STUDY_SPACES_CHANGED_EVENT = 'study-spaces-changed';

export interface StudyNav {
  /** Study spaces are served and an account is signed in. */
  available: boolean;
  capabilities: StudyCapabilities | null;
  /** Active spaces, most recently studied first; empty until loaded. */
  spaces: StudySpaceSummary[];
}

let spacesCache: { userId: string; spaces: StudySpaceSummary[] } | null = null;

function recentFirst(spaces: StudySpaceSummary[]): StudySpaceSummary[] {
  const key = (space: StudySpaceSummary) => space.lastStudied?.updatedAt ?? space.updatedAt;
  return spaces
    .filter((space) => space.status === 'active')
    .sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0));
}

export function useStudyNav(): StudyNav {
  const [nav, setNav] = useState<StudyNav>(() => ({
    available: false,
    capabilities: null,
    spaces: spacesCache?.spaces ?? [],
  }));

  useEffect(() => {
    let cancelled = false;
    const refresh = (reloadSpaces: boolean) => {
      const userId = peekAccountUserId();
      void fetchStudyCapabilities().then((capabilities) => {
        if (cancelled) return;
        const available = capabilities.spaces && Boolean(userId);
        if (!available || !userId) {
          setNav({ available: false, capabilities, spaces: [] });
          return;
        }
        const cached = spacesCache?.userId === userId ? spacesCache.spaces : null;
        setNav({ available, capabilities, spaces: cached ?? [] });
        if (cached && !reloadSpaces) return;
        studyApi
          .listSpaces()
          .then((list) => {
            spacesCache = { userId, spaces: recentFirst(list) };
            if (!cancelled) setNav({ available, capabilities, spaces: spacesCache.spaces });
          })
          .catch(() => {
            // The sidebar degrades to the plain "my spaces" link.
          });
      });
    };
    refresh(false);
    const onAuth = () => refresh(true);
    const onSpaces = () => refresh(true);
    window.addEventListener('auth-change', onAuth);
    window.addEventListener(STUDY_SPACES_CHANGED_EVENT, onSpaces);
    return () => {
      cancelled = true;
      window.removeEventListener('auth-change', onAuth);
      window.removeEventListener(STUDY_SPACES_CHANGED_EVENT, onSpaces);
    };
  }, []);

  return nav;
}

/** The configured runtime probe result, retained across client navigations. */
let ultraRuntimeCache: boolean | null = null;

/**
 * The Ultra workbench entry (the multi-session AI workbench at /workspace):
 * shown when the build ships it and the agent runtime is configured.
 */
export function useUltraEntry(): { enabled: boolean; enter: () => void } {
  const router = useRouter();
  const buildEnabled = isProWorkbenchEnabled();
  const [runtimeEnabled, setRuntimeEnabled] = useState(ultraRuntimeCache === true);

  useEffect(() => {
    if (!buildEnabled || ultraRuntimeCache !== null) return;
    let cancelled = false;
    fetch('/api/agent/runtime')
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        ultraRuntimeCache = body?.enabled === true;
        if (!cancelled) setRuntimeEnabled(ultraRuntimeCache);
      })
      .catch(() => {
        // A failed probe keeps the entry hidden and allows a later visit to retry.
      });
    return () => {
      cancelled = true;
    };
  }, [buildEnabled]);

  const enabled = buildEnabled && runtimeEnabled;
  useEffect(() => {
    if (enabled) router.prefetch('/workspace');
  }, [router, enabled]);

  return {
    enabled,
    enter: () => {
      const href = workspaceResumeHref(readLastWorkspaceSessionId());
      startProSwap(href, (next) => router.push(next));
    },
  };
}
