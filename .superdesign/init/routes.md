# Routes

Next.js App Router. Root layout is always `app/layout.tsx` (ThemeProvider, I18nProvider, AccessCodeGuard, Toaster). There is **no** `QingjinAppShell` and **no** dedicated `/settings` route — settings is `SettingsDialog` from `components/settings/index.tsx`.

Docs routes under `packages/docs/` are a separate package and are not product UI.

---

## `/`

- **URL:** `/`
- **File:** `app/page.tsx` (`HomePage`; default export wraps it)
- **Layout:** `app/layout.tsx` only. Chrome is an inline fixed top bar in the page (not a shared shell).
- **Summary:** Qingjin home: Paper-background column with a fixed 56px product bar (衿 bronze seal + 青衿 wordmark, optional Pro badge, language, theme, settings), then a centered hero + composer and a discover grid of folders/classrooms. Generate / import / settings all stay on this page; generate navigates to `/generation-preview`.

---

## `/classroom/[id]`

- **URL:** `/classroom/[id]`
- **File:** `app/classroom/[id]/page.tsx` (`ClassroomDetailPage`)
- **Layout:** `app/layout.tsx` + a full-viewport `h-screen` flex column. Nested `ThemeProvider` + `MediaStageProvider`. No shared app header — classroom chrome is `Stage` → `PlaybackChromeRoot`.
- **Summary:** Loads the classroom into the stage store, then mounts `Stage`. Playback fills the viewport with SceneSidebar, Header, CanvasArea, Roundtable, and ChatArea; Pro/edit swaps to `EditChromeRoot`. Settings remains a dialog opened from HeaderControls.

---

## `/generation-preview`

- **URL:** `/generation-preview`
- **File:** `app/generation-preview/page.tsx` (`GenerationPreviewPage` → `GenerationPreviewContent` inside Suspense)
- **Layout:** `app/layout.tsx` only. Centered card on a slate gradient; ghost back button, not the home header.
- **Summary:** Multi-step course generation (outline / agents / scenes / media) with progress dots, `StepVisualizer`, optional `OutlinesEditor`, and `AgentRevealModal`. On success it routes into `/classroom/[id]`.

---

## `/workspace`

- **URL:** `/workspace` (query: `?session=`, `?course=`, or both)
- **File:** `app/workspace/page.tsx` → `WorkspaceEntry` → `WorkspaceShell`
- **Layout:** `app/layout.tsx`. Comments mention `AppChrome` / `SiteHeader` suppression; those shells are **not** implemented as product components. The page is a full-`100dvh` `.ws-root` three-pane workspace (rail / chat / classroom) with no global header.
- **Summary:** Pro workbench home. Bare `/workspace` shows `WorkspaceHome` (lockup + composer + discover). Opening a session and/or course mounts `WorkspaceChatPane` and/or `WorkspaceClassroomPane` beside `WorkspaceRail`. Settings is still a dialog from the rail footer.

---

## `/workbench/new`

- **URL:** `/workbench/new` (legacy `?prompt=` / `?skill=`)
- **File:** `app/workbench/new/page.tsx` → `app/workbench/new/client.tsx` (`WorkbenchLaunchBridge`)
- **Layout:** `app/layout.tsx` only. No composer or product chrome.
- **Summary:** Compatibility bridge: consumes an old launch intent, creates a workbench session, and `replace`s to `/workspace?session=…`. If workbench flags are off, `notFound()`.

---

## Settings (not a route)

- **URL:** none
- **File:** `components/settings/index.tsx` (`SettingsDialog`)
- **Layout:** Dialog overlay on whatever page opened it (`/` header, classroom HeaderControls, workspace rail).
- **Summary:** Modal for providers, models, TTS/ASR, media, general, skills, usage. Opened with `open` / `onOpenChange` / optional `initialSection`.
