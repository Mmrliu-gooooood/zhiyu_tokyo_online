# Extractable components

Menu for Superdesign `DraftComponent` extraction. No `QingjinAppShell` — home chrome is inline.

---

## QingjinHomeHeader

- Source: `app/page.tsx` (inline, ~lines 723–816; not a standalone file)
- Category: layout
- Description: Fixed 56px Qingjin product bar — bronze 衿 seal, 青衿 wordmark, optional Pro badge, language, theme menu, settings gear
- Extractable props: `workbenchEntryEnabled` (boolean, default: false), `theme` (`light` | `dark` | `system`), `themeOpen` (boolean), `settingsOpen` (boolean)
- Hardcoded: 衿 seal (`bg-[#8A6A3D]`, `rounded-[3px]`, `var(--font-display)`), 青衿 wordmark, `h-14` bar, `bg-card/72 backdrop-blur-md border-b`, Sun/Moon/Monitor icons, Settings icon, i18n theme option keys

---

## SceneSidebar

- Source: `components/stage/scene-sidebar.tsx`
- Category: layout
- Description: Collapsible left scene rail with OpenMAIC logo, numbered scene cards, and slide/quiz/interactive thumbnails
- Extractable props: `collapsed` (boolean), `onCollapseChange`, `onSceneSelect`, `onRetryOutline`, `isCourseComplete` (boolean)
- Hardcoded: `/logo-horizontal.png`, DEFAULT/MIN/MAX width 220/170/400, `bg-white/80 backdrop-blur-xl`, purple active ring, Lucide type icons (BookOpen/PieChart/MousePointer2/Cpu), collapse `PanelLeftClose`

---

## Header

- Source: `components/header.tsx`
- Category: layout
- Description: Classroom playback top bar — optional back arrow, “current scene” eyebrow + title, then `HeaderControls`
- Extractable props: `currentSceneTitle` (string), `mode` (`StageMode`), `proModeActive` (boolean), `canEdit` (boolean), `onToggleEditMode`, `backControl` (ReactNode), `hideBackControl` (boolean), `hideGlobalControls` (boolean), `hideCourseActions` (boolean)
- Hardcoded: `h-20 px-8`, ArrowLeft home/exit, uppercase tracking eyebrow (`stage.currentScene`), gray title classes

---

## HeaderControls

- Source: `components/stage/header-controls.tsx`
- Category: layout
- Description: Capsule cluster for language, theme, settings, Pro switch, and export/download menu
- Extractable props: `mode`, `proModeActive`, `canEdit`, `onToggleEditMode`, `showGlobalControls` (boolean, default: true), `showCourseActions` (boolean, default: true), `variant` (`default` | `compact`)
- Hardcoded: frosted pill (`rounded-full`, `bg-white/60 backdrop-blur-md`), violet Pro switch, Lucide export icons, SettingsDialog + VideoExportDialog hosts

---

## ChatArea

- Source: `components/chat/chat-area.tsx`
- Category: layout
- Description: Right lecture/chat panel with line tabs, session list / notes, and drag-to-resize
- Extractable props: `collapsed` (boolean), `onCollapseChange`, `width` (number, default: 340), `onWidthChange`, `className`, `currentSceneId`, `activeBubbleId`
- Hardcoded: MIN/MAX 240/560, `bg-white/80 backdrop-blur-xl border-l`, BookOpen / MessageSquare tab icons, amber pulse dot, `PanelRightClose`

---

## Roundtable

- Source: `components/roundtable/index.tsx`
- Category: layout
- Description: Bottom participant strip — avatars, live speech, mic/send, optional playback toolbar
- Extractable props: `mode` (`playback` | `autonomous`), `initialParticipants`, `playbackView`, speech/idle/streaming flags, `onMessageSend`, `onPlayPause`, `onDiscussionStart` / skip / stop / continue, toolbar callbacks (`onToggleSidebar`, `onToggleChat`, slide nav)
- Hardcoded: default teacher/user avatars, voice-waveform bar peaks, `max-h-[100px]` input, Lucide mic/send/play icons, HoverCard + AvatarDisplay chrome

---

## CanvasToolbar

- Source: `components/canvas/canvas-toolbar.tsx`
- Category: basic
- Description: Compact slide transport — prev/next, play/pause, volume, sidebar/chat toggles, present, whiteboard
- Extractable props: `currentSceneIndex`, `scenesCount`, `engineState` (`idle` | `playing` | `paused`), `whiteboardOpen`, `sidebarCollapsed`, `chatCollapsed`, `isPresenting`, `isLiveSession`, TTS mute/volume/speed, `elementPickActive`, all `on*` callbacks, `className`
- Hardcoded: `w-7 h-7` control buttons, CtrlDivider, Volume1/2/X icons, Quote element-pick, Maximize2/Minimize2 present

---

## WorkspaceRail

- Source: `components/workbench/workspace/WorkspaceRail.tsx`
- Category: layout
- Description: Pro workspace left nav — wordmark + Pro badge, new-session row, Sessions/Courses tabs, fold, footer utilities
- Extractable props: `collapsed`, `onToggleCollapsed`, `activeCourseId`, `activeSessionId`, `sessions`, `courses`, `onOpenCourse`, `onOpenSession`, `onNewSession`, `onGoHome`, `onExitPro`, `resizeHandle`
- Hardcoded: `.ws-rail` / `--ws-rail-w`, brand `logoSrc` img (`h-[21px]`), ProBadge, Plus new-session row, Sessions/Courses tab ids, LanguageSwitcher + ThemeToggle + Settings in the foot
