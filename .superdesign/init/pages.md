# Pages — component dependency trees

Local UI imports only, 1–2 levels. Skip `node_modules`, stores, hooks, and lib unless they render UI. Candidate `--context-file` set — apply PAYLOAD BUDGET when designing.

---

## `/` Home

Entry: `app/page.tsx` (`HomePage`; default `Page` → `HomePage`)

Dependencies:

- `components/language-switcher.tsx`
- `components/ui/button.tsx`
- `components/ui/input-group.tsx`
  - `components/ui/button.tsx`
  - `components/ui/input.tsx`
  - `components/ui/textarea.tsx`
- `components/ui/textarea.tsx`
- `components/ui/tooltip.tsx`
- `components/settings/index.tsx` (`SettingsDialog` — not a route)
  - `components/ui/dialog.tsx`
  - `components/settings/general-settings.tsx` (+ provider / TTS / image / … panels)
- `components/generation/generation-toolbar.tsx`
- `components/generation/interactive-mode-button.tsx`
- `components/agent/agent-bar.tsx`
- `components/discovery/folder-card.tsx`
- `components/discovery/folder-dialogs.tsx` (`NewFolderDialog`)
- `components/discovery/move-to-folder-menu.tsx`
- `components/slide-renderer/SlideThumbnail.tsx`
- `components/audio/speech-button.tsx`
- `components/workbench/ProBadge.tsx`
- Inline in the same file: `GreetingBar` (profile/avatar row above the composer)

Layout chrome: fixed Qingjin header is **inline JSX** in `app/page.tsx` (~lines 723–816). There is no `QingjinAppShell`.

---

## `/classroom/[id]`

Entry: `app/classroom/[id]/page.tsx` (`ClassroomDetailPage`)

Dependencies:

- `components/stage.tsx` (`Stage`)
  - `components/edit/PlaybackChromeRoot.tsx`
  - `components/edit/EditChromeRoot.tsx`
  - `components/scene-renderers/InteractiveIframeHost.tsx`
  - `components/workbench/WorkbenchReturnControl.tsx`

`PlaybackChromeRoot` →

- `components/header.tsx` (`Header`)
  - `components/stage/header-controls.tsx` (`HeaderControls`)
    - `components/language-switcher.tsx`
    - `components/settings/index.tsx`
    - `components/stage/video-export-dialog.tsx`
    - `components/ui/switch.tsx`, `dropdown-menu.tsx`, `circular-progress.tsx`
- `components/stage/scene-sidebar.tsx` (`SceneSidebar`)
  - `components/slide-renderer/SlideThumbnail.tsx`
  - `components/slide-renderer/components/ThumbnailInteractive.tsx`
- `components/canvas/canvas-area.tsx` (`CanvasArea`)
  - `components/stage/scene-renderer.tsx`
  - `components/whiteboard` (whiteboard overlay)
  - `components/canvas/canvas-toolbar.tsx` (`CanvasToolbar`)
  - `components/scene-renderers/classroom-complete.tsx`
  - `components/edit/ContainBox.tsx`
  - `components/canvas/slide-element-pick-overlay.tsx`
- `components/roundtable/index.tsx` (`Roundtable`)
  - `components/canvas/canvas-toolbar.tsx`
  - `components/chat/proactive-card.tsx`
  - `components/roundtable/presentation-speech-overlay.tsx`
  - `components/ui/avatar-display.tsx`
- `components/chat/chat-area.tsx` (`ChatArea`)
  - `components/chat/session-list.tsx`
  - `components/chat/lecture-notes-view.tsx`
  - `components/ui/tabs.tsx`

---

## `/generation-preview`

Entry: `app/generation-preview/page.tsx` (`GenerationPreviewPage` → `GenerationPreviewContent`)

Dependencies:

- `components/ui/button.tsx`
- `components/ui/card.tsx`
- `components/ui/tooltip.tsx`
- `components/generation/outlines-editor.tsx`
- `components/agent/agent-reveal-modal.tsx`
- `app/generation-preview/components/visualizers` (`StepVisualizer`)
- `app/generation-preview/types.ts` (step copy / `ALL_STEPS`)

No shared header. Back control is a ghost `Button` in the page.

---

## `/workspace`

Entry: `app/workspace/page.tsx` → `components/workbench/WorkspaceEntry.tsx` → `components/workbench/workspace/WorkspaceShell.tsx`

`WorkspaceShell` →

- `components/workbench/workspace/WorkspaceRail.tsx`
  - `components/workbench/ProBadge.tsx`
  - `components/language-switcher.tsx`
  - `components/site-header/theme-toggle.tsx`
  - `components/settings/index.tsx`
  - `components/workbench/workspace/PaneFoldButton.tsx`
- `components/workbench/workspace/WorkspaceChatPane.tsx`
  - `components/workbench/WorkbenchChat.tsx`
- `components/workbench/workspace/WorkspaceClassroomPane.tsx`
  - classroom `Stage` / `ClassroomSurface` (same classroom chrome as `/classroom/[id]`, hosted)
- `components/workbench/workspace/WorkspaceHome.tsx`
  - `components/workbench/ProBadge.tsx`
  - `components/workbench/ProLaunchPanel.tsx`
- `components/workbench/workspace/PaneTab.tsx`
- `components/workbench/workspace/ResizeHandle.tsx`

Scoped CSS: `components/workbench/workspace-shell.css` (imported only from `WorkspaceShell`).

---

## `/workbench/new`

Entry: `app/workbench/new/page.tsx` → `app/workbench/new/client.tsx` (`WorkbenchLaunchBridge`)

Dependencies: lucide `Loader2` + toast only. No product layout. Redirects to `/workspace`.
