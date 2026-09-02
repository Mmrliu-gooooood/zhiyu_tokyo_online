'use client';

import { memo } from 'react';
import { WorkspaceChatPane } from './WorkspaceChatPane';
import { WorkspaceClassroomPane } from './WorkspaceClassroomPane';
import { WorkspaceRail } from './WorkspaceRail';

/** Memo boundaries only; each island returns the existing component with no wrapper DOM. */
export const WorkspaceRailIsland = memo(WorkspaceRail);
export const WorkspaceChatIsland = memo(WorkspaceChatPane);
export const WorkspaceClassroomIsland = memo(WorkspaceClassroomPane);
