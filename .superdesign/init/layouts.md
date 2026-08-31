# Layouts

There is **no** `QingjinAppShell`. Product chrome is per-surface: home inline header, classroom `Header` + `HeaderControls` + `SceneSidebar`, workspace `WorkspaceShell` + `WorkspaceRail`. Root HTML shell is `app/layout.tsx`.

---

## Root layout — `app/layout.tsx`

Providers only. No nav/header/footer. Title 青衿.

```tsx
import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import './globals.css';
import '@openmaic/renderer/fonts.css';
import 'animate.css';
import 'katex/dist/katex.min.css';
import { ThemeProvider } from '@/lib/hooks/use-theme';
import { I18nProvider } from '@/lib/hooks/use-i18n';
import { Toaster } from '@/components/ui/sonner';
import { ServerProvidersInit } from '@/components/server-providers-init';
import { StorageHealthNotice } from '@/components/storage-health-notice';
import { AccessCodeGuard } from '@/components/access-code-guard';
import { ProSwapWatcher } from '@/components/workbench/ProSwapWatcher';

// The UI font is loaded from @fontsource's stylesheet rather than next/font,
// because only the stylesheet carries the per-subset `unicode-range`
// declarations. Pointing next/font at `inter-latin-wght-normal.woff2` loaded
// exactly one subset, so every character outside Latin — Cyrillic for ru-RU,
// tone-marked letters for vi-VN — fell back to an arbitrary OS font and
// rendered in a different typeface mid-word.
//
// Declaring the other subset files as sibling faces of the same family does not
// fix it either: faces with identical descriptors and no `unicode-range` do not
// fall through per glyph, so the browser simply picks one.
//
// `--font-sans` moves to globals.css since the family no longer comes from
// next/font's generated class.
import '@fontsource-variable/inter';
// Subset only: the full 400.css/700.css entries emit ~200 unicode-range
// @font-face rules and stall first-page Turbopack compile on Windows.
import '@fontsource/noto-serif-sc/chinese-simplified-700.css';

export const metadata: Metadata = {
  title: '青衿',
  description: '一句话，生成一堂多智能体互动课。',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${GeistSans.variable} ${GeistMono.variable} antialiased`}
        suppressHydrationWarning
      >
        <ThemeProvider>
          <I18nProvider>
            <ServerProvidersInit />
            <ProSwapWatcher />
            <AccessCodeGuard>{children}</AccessCodeGuard>
            <Toaster position="top-center" />
            {/* After the Toaster: this one raises a toast on mount when
                persistence is already broken, and a toast raised before its
                host exists has nowhere to go. */}
            <StorageHealthNotice />
          </I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
```

---

## Home inline header — `app/page.tsx` (~700–824)

Not a shared component. Fixed `h-14` bar: 衿 seal + 青衿 + optional ProBadge, language, theme dropdown, settings (opens `SettingsDialog`).

```tsx
  return (
    <div className="relative min-h-[100dvh] w-full bg-background text-foreground flex flex-col items-center p-4 pt-20 md:p-8 md:pt-20 overflow-x-hidden">
      <input
        ref={fileInputRef}
        type="file"
        accept=".zip"
        onChange={handleFileChange}
        className="hidden"
      />
      {PPTX_IMPORT_ENABLED && (
        <input
          ref={pptxFileInputRef}
          type="file"
          accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
          onChange={handlePptxFileChange}
          className="hidden"
        />
      )}
      {/* ═══ Product top bar ═══ */}
      <div
        ref={toolbarRef}
        className="fixed top-0 inset-x-0 z-50 h-14 px-4 md:px-8 flex items-center justify-between bg-card/72 backdrop-blur-md border-b border-border"
      >
        <div className="flex items-center gap-2 min-w-0" data-pro-morph="lockup">
          <span
            aria-hidden
            className="inline-flex size-7 items-center justify-center rounded-[3px] bg-[#8A6A3D] text-[11px] font-bold text-[#FBFCFB] ring-1 ring-[#FBFCFB]/70"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            衿
          </span>
          <span
            className="text-[22px] font-semibold tracking-tight text-foreground"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            青衿
          </span>
          {workbenchEntryEnabled ? (
            <div className="ml-1" data-pro-morph="badge">
              <ProBadge active={false} onToggle={enterWorkbench} />
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-0.5">
          <LanguageSwitcher onOpen={() => setThemeOpen(false)} />

          <div className="relative">
            <button
              onClick={() => {
                setThemeOpen(!themeOpen);
              }}
              className="p-2 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-all"
            >
              {theme === 'light' && <Sun className="w-4 h-4" />}
              {theme === 'dark' && <Moon className="w-4 h-4" />}
              {theme === 'system' && <Monitor className="w-4 h-4" />}
            </button>
            {themeOpen && (
              <div className="absolute top-full mt-2 right-0 bg-card border border-border rounded-lg shadow-lg overflow-hidden z-50 min-w-[140px]">
                <button
                  onClick={() => {
                    setTheme('light');
                    setThemeOpen(false);
                  }}
                  className={cn(
                    'w-full px-4 py-2 text-left text-sm hover:bg-muted transition-colors flex items-center gap-2',
                    theme === 'light' && 'bg-primary/10 text-primary',
                  )}
                >
                  <Sun className="w-4 h-4" />
                  {t('settings.themeOptions.light')}
                </button>
                <button
                  onClick={() => {
                    setTheme('dark');
                    setThemeOpen(false);
                  }}
                  className={cn(
                    'w-full px-4 py-2 text-left text-sm hover:bg-muted transition-colors flex items-center gap-2',
                    theme === 'dark' && 'bg-primary/10 text-primary',
                  )}
                >
                  <Moon className="w-4 h-4" />
                  {t('settings.themeOptions.dark')}
                </button>
                <button
                  onClick={() => {
                    setTheme('system');
                    setThemeOpen(false);
                  }}
                  className={cn(
                    'w-full px-4 py-2 text-left text-sm hover:bg-muted transition-colors flex items-center gap-2',
                    theme === 'system' && 'bg-primary/10 text-primary',
                  )}
                >
                  <Monitor className="w-4 h-4" />
                  {t('settings.themeOptions.system')}
                </button>
              </div>
            )}
          </div>

          <div className="relative">
            <button
              onClick={() => setSettingsOpen(true)}
              className="p-2 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-all group"
            >
              <Settings className="w-4 h-4 group-hover:rotate-90 transition-transform duration-500" />
            </button>
          </div>
        </div>
      </div>
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={(open) => {
          setSettingsOpen(open);
          if (!open) setSettingsSection(undefined);
        }}
        initialSection={settingsSection}
      />
```

---

## Classroom header — `components/header.tsx` (full)

`h-20` transparent bar. Left: back (or `backControl`) + current-scene title. Right: `HeaderControls`.

```tsx
'use client';

import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useRouter, useSearchParams } from 'next/navigation';
import type { StageMode } from '@/lib/types/stage';
import { classroomExitLabelKey, exitClassroom } from '@/lib/workbench/classroom-exit';
import { HeaderControls } from './stage/header-controls';

interface HeaderProps {
  readonly currentSceneTitle: string;
  readonly mode?: StageMode;
  readonly proModeActive?: boolean;
  readonly canEdit?: boolean;
  readonly onToggleEditMode?: () => void;
  /** Replaces the default back-to-home arrow as the header's leftmost
      control. `PlaybackChromeRoot` passes the workbench's return control
      here while a session is attached and full-screen playback is on, so the
      top-left back affordance becomes the back-to-workspace control instead of a home arrow
      (which would navigate away from the hosted classroom entirely). */
  readonly backControl?: ReactNode;
  /** Drops the back slot entirely (no `backControl`, no home arrow). The
      embedded workbench form uses this: the conversation sits beside/above
      the classroom, so any back affordance here would duplicate the chat's
      own back and could exit the workbench. */
  readonly hideBackControl?: boolean;
  /** Hide application-global controls in a workbench-attached classroom. */
  readonly hideGlobalControls?: boolean;
  /** Hide course-level share/export in a workbench-attached classroom. */
  readonly hideCourseActions?: boolean;
}

export function Header({
  currentSceneTitle,
  mode,
  proModeActive,
  canEdit,
  onToggleEditMode,
  backControl,
  hideBackControl,
  hideGlobalControls,
  hideCourseActions,
}: HeaderProps) {
  const { t } = useI18n();
  const router = useRouter();
  const searchParams = useSearchParams();
  const exitLabel = t(classroomExitLabelKey(searchParams));

  return (
    <>
      <header className="h-20 px-8 flex items-center justify-between z-10 bg-transparent gap-4">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          {hideBackControl
            ? null
            : (backControl ?? (
                <button
                  onClick={() => exitClassroom(router, searchParams)}
                  className="shrink-0 p-2 rounded-lg text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
                  title={exitLabel}
                  aria-label={exitLabel}
                >
                  <ArrowLeft className="w-5 h-5" />
                </button>
              ))}
          {/* Title block — hidden when `mode === 'edit'`. Header lives
              inside `PlaybackChromeRoot`, which is unmounted by `Stage`
              once mode flips to 'edit', so in steady state this branch
              is always taken. The guard exists for the ~280ms
              AnimatePresence exit window where the playback chrome
              is still rendering its exit animation while `mode` has
              already flipped — without the guard, this title would
              briefly stack on top of the incoming EditChromeRoot's
              CommandBar title during the cross-fade. */}
          {mode !== 'edit' && (
            <div className="flex flex-col min-w-0">
              <span className="text-[10px] uppercase tracking-widest font-bold text-gray-400 dark:text-gray-500 mb-0.5">
                {t('stage.currentScene')}
              </span>
              <h1
                className="text-xl font-bold text-gray-800 dark:text-gray-200 tracking-tight truncate"
                suppressHydrationWarning
              >
                {currentSceneTitle || t('common.loading')}
              </h1>
            </div>
          )}
        </div>

        {/* Standalone classroom keeps the full cluster. Workbench-attached
            classrooms omit both the global capsule and course share/export. */}
        <HeaderControls
          mode={mode}
          proModeActive={proModeActive}
          canEdit={canEdit}
          onToggleEditMode={onToggleEditMode}
          showGlobalControls={!hideGlobalControls}
          showCourseActions={!hideCourseActions}
        />
      </header>
    </>
  );
}
```

---

## HeaderControls — `components/stage/header-controls.tsx` (full, 400 lines)

Language / theme / settings pill, Pro switch, export menu. Used by classroom `Header` and Pro CommandBar.

```tsx
'use client';

import { useState } from 'react';
import {
  Archive,
  Download,
  FileDown,
  Film,
  Loader2,
  Monitor,
  Moon,
  NotebookText,
  Package,
  Settings,
  Sun,
} from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useTheme } from '@/lib/hooks/use-theme';
import { useStageStore } from '@/lib/store';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { useExportPPTX } from '@/lib/export/use-export-pptx';
import { useExportClassroom } from '@/lib/export/use-export-classroom';
import { isScriptExportReady, useExportScript } from '@/lib/export/use-export-script';
import { isVideoExportEnabled } from '@/lib/config/feature-flags';
import { useVideoRenderStore } from '@/lib/store/video-render';
import { CircularProgress } from '@/components/ui/circular-progress';
import { VideoExportDialog } from './video-export-dialog';
import { LanguageSwitcher } from '../language-switcher';
import { SettingsDialog } from '../settings';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { StageMode } from '@/lib/types/stage';

interface HeaderControlsProps {
  readonly mode?: StageMode;
  readonly proModeActive?: boolean;
  readonly canEdit?: boolean;
  readonly onToggleEditMode?: () => void;
  readonly showGlobalControls?: boolean;
  readonly showCourseActions?: boolean;
  /**
   * `default` — the chunky h-9 pill used in the playback Stage Header.
   * `compact` — slightly tighter padding for embedding in CommandBar's
   * right slot (Pro mode chrome already eats height, so the pill backs
   * off ring weight / blur to keep the CommandBar quiet).
   */
  readonly variant?: 'default' | 'compact';
}

/**
 * Stage-level global controls: language picker, theme picker, settings
 * modal trigger, and the Pro Switch. Extracted out of `Header` so the
 * Pro mode CommandBar can absorb the same affordances and the playback
 * Header doesn't need to stay mounted just to host them — Pro mode
 * therefore lands on a single top-chrome bar instead of stacking the
 * Stage Header above the EditShell CommandBar.
 *
 * Only one instance is ever mounted at a time (Stage renders Header
 * for playback and EditShell.CommandBar's trailing slot for edit, but
 * never both), so dropdown / dialog state and refs stay co-located
 * here without cross-instance leakage.
 */
export function HeaderControls({
  mode,
  proModeActive,
  canEdit,
  onToggleEditMode,
  showGlobalControls = true,
  showCourseActions = true,
  variant = 'default',
}: HeaderControlsProps) {
  const { t } = useI18n();
  const { theme, setTheme } = useTheme();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [videoDialogOpen, setVideoDialogOpen] = useState(false);

  // Export plumbing — uses the stage / media task stores to check
  // readiness, then hands off to the export hooks. Available in both
  // playback and edit chrome so the icon's screen position is stable
  // across mode swaps (was previously in `Header` only, missing from
  // CommandBar's right cluster).
  const scenes = useStageStore((s) => s.scenes);
  const generatingOutlines = useStageStore((s) => s.generatingOutlines);
  const failedOutlines = useStageStore((s) => s.failedOutlines);
  const mediaTasks = useMediaGenerationStore((s) => s.tasks);
  const { exporting: isExporting, exportPPTX, exportResourcePack } = useExportPPTX();
  const { exporting: isExportingZip, exportClassroomZip } = useExportClassroom();
  const { exporting: isExportingScript, exportScriptDocx, exportScriptMd } = useExportScript();
  const videoExportEnabled = isVideoExportEnabled();
  // Video render lives in a global store so its progress ring stays on the
  // export button even after the menu closes / scenes switch mid-render.
  const videoRendering = useVideoRenderStore(
    (s) => s.status === 'compiling' || s.status === 'rendering',
  );
  const videoRenderPercent = useVideoRenderStore((s) => s.percent);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);

  // Keep the original full-generation gate for the export menu. Script files
  // are text-only, but the latest review confirmed that this menu intentionally
  // stays unavailable until all media tasks have completed or failed.
  const canExport = isScriptExportReady({ scenes, generatingOutlines, failedOutlines }, mediaTasks);
  const exportLabel = canExport ? t('export.pptx') : t('share.notReady');

  const compact = variant === 'compact';
  const proChecked = proModeActive ?? mode === 'edit';

  if (!showGlobalControls && !showCourseActions) {
    return onToggleEditMode ? (
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-gray-600 dark:text-gray-300">
          {t('stage.proMode')}
        </span>
        <Switch
          checked={proChecked}
          onCheckedChange={onToggleEditMode}
          disabled={!canEdit}
          aria-label={proChecked ? t('stage.doneEditing') : t('stage.editCourse')}
        />
      </div>
    ) : null;
  }

  // Self-contained spacing so the control cluster is identical regardless of
  // host. The playback Header (`gap-4`) and the edit CommandBar's trailing
  // slot (`gap-2`) would otherwise impose different inter-control spacing on
  // these fragment children, making the pill/switch/export cluster visibly
  // shift width and position across the mode swap. A fixed internal gap keeps
  // the cluster pixel-stable; both hosts pad to `px-8`, so the right edge
  // anchors identically too.
  return (
    <div className="flex items-center gap-4">
      <div
        className={cn(
          'shrink-0 flex items-center gap-1 backdrop-blur-md shadow-sm rounded-full',
          compact
            ? 'bg-zinc-100/70 dark:bg-zinc-800/70 border border-zinc-200/60 dark:border-zinc-700/60 px-1.5 py-1'
            : 'bg-white/60 dark:bg-gray-800/60 border border-gray-100/50 dark:border-gray-700/50 px-2 py-1.5',
        )}
      >
        {/* Language — Radix DropdownMenu so its menu portals to body
            and never gets clipped by an ancestor's overflow-hidden. */}
        <LanguageSwitcher />

        {/* Theme — same Portal-backed DropdownMenu pattern. Non-modal keeps
            Radix from body scroll-locking a fixed-height classroom layout. */}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              className="p-2 rounded-full text-gray-400 dark:text-gray-500 hover:bg-white dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-gray-200 hover:shadow-sm transition-all group"
              aria-label={t('settings.theme')}
            >
              {theme === 'light' && <Sun className="w-4 h-4" />}
              {theme === 'dark' && <Moon className="w-4 h-4" />}
              {theme === 'system' && <Monitor className="w-4 h-4" />}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={8} className="min-w-[140px]">
            <DropdownMenuItem
              onSelect={() => setTheme('light')}
              className={cn(
                'cursor-pointer gap-2',
                theme === 'light' &&
                  'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400',
              )}
            >
              <Sun className="w-4 h-4" />
              {t('settings.themeOptions.light')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setTheme('dark')}
              className={cn(
                'cursor-pointer gap-2',
                theme === 'dark' &&
                  'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400',
              )}
            >
              <Moon className="w-4 h-4" />
              {t('settings.themeOptions.dark')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setTheme('system')}
              className={cn(
                'cursor-pointer gap-2',
                theme === 'system' &&
                  'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400',
              )}
            >
              <Monitor className="w-4 h-4" />
              {t('settings.themeOptions.system')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Settings */}
        <button
          onClick={() => setSettingsOpen(true)}
          className="p-2 rounded-full text-gray-400 dark:text-gray-500 hover:bg-white dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-gray-200 hover:shadow-sm transition-all group"
          aria-label={t('settings.title')}
        >
          <Settings className="w-4 h-4 group-hover:rotate-90 transition-transform duration-500" />
        </button>
      </div>

      {/* Pro Switch — toggle property: on/off both clickable, not a
          one-way "Done" button. Disabled only when the current scene
          can't be entered (pending/generating/etc.). Fades in with its
          host bar on the mode swap (no cross-bar layoutId morph: the
          playback Header and edit CommandBar have different left-side
          widths, so morphing made the pill visibly drift). */}
      {onToggleEditMode && (
        <label
          className={cn(
            'shrink-0 inline-flex items-center gap-2.5 rounded-full border shadow-sm transition-colors duration-200',
            'bg-white/60 dark:bg-gray-800/60 backdrop-blur-md',
            compact ? 'h-8 px-2.5' : 'h-9 px-3',
            proChecked
              ? 'border-violet-500/60 dark:border-violet-400/60'
              : 'border-gray-100/50 dark:border-gray-700/50',
            !canEdit && mode !== 'edit'
              ? 'opacity-60 cursor-not-allowed'
              : 'cursor-pointer hover:border-violet-400/60 dark:hover:border-violet-500/50',
          )}
          // When disabled (e.g. the course-complete placeholder), explain why
          // on hover and point the user to a real scene instead of a bare
          // "Edit course" label they can't act on.
          title={
            !canEdit && mode !== 'edit'
              ? t('stage.proModeDisabledHint')
              : proChecked
                ? t('stage.doneEditing')
                : t('stage.editCourse')
          }
        >
          <span
            className={cn(
              'text-[11px] font-bold uppercase tracking-[0.14em] tabular-nums select-none transition-colors duration-200',
              proChecked
                ? 'text-violet-600 dark:text-violet-300'
                : 'text-gray-500 dark:text-gray-400',
            )}
          >
            {t('edit.proMode')}
          </span>
          <Switch
            checked={proChecked}
            onCheckedChange={onToggleEditMode}
            disabled={!canEdit && mode !== 'edit'}
            aria-label={proChecked ? t('stage.doneEditing') : t('stage.editCourse')}
            className="data-[state=checked]:bg-violet-600 dark:data-[state=checked]:bg-violet-500"
          />
        </label>
      )}

      {/* Export / Download — lives to the right of the Pro Switch.
          Not a settings function so it does not belong inside the
          settings pill; kept as a separate sibling sitting between the
          Pro Switch and the right edge of the chrome. */}
      <DropdownMenu modal={false} open={exportMenuOpen} onOpenChange={setExportMenuOpen}>
        <DropdownMenuTrigger asChild>
          <button
            disabled={!canExport || isExporting || isExportingZip || isExportingScript}
            title={
              isExporting || isExportingZip || isExportingScript
                ? t('export.exporting')
                : exportLabel
            }
            className={cn(
              'shrink-0 p-2 rounded-full transition-all',
              canExport && !isExporting && !isExportingZip && !isExportingScript
                ? 'text-gray-400 dark:text-gray-500 hover:bg-white dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-gray-200 hover:shadow-sm'
                : 'text-gray-300 dark:text-gray-600 cursor-not-allowed opacity-50',
            )}
            aria-label={exportLabel}
          >
            {isExporting || isExportingZip || isExportingScript ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : videoRendering ? (
              // Persistent ring: video render runs in the background; keep it
              // visible on the button whether or not the menu is open.
              <CircularProgress value={videoRenderPercent} size={20} className="text-primary" />
            ) : (
              <Download className="w-4 h-4" />
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={8} className="min-w-[240px]">
          <DropdownMenuItem
            disabled={!canExport}
            onSelect={exportPPTX}
            className="cursor-pointer gap-2.5"
            title={canExport ? undefined : t('export.mediaPending')}
          >
            <FileDown className="w-4 h-4 text-gray-400 shrink-0" />
            <span>{t('export.pptx')}</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!canExport}
            onSelect={exportResourcePack}
            className="cursor-pointer gap-2.5"
            title={canExport ? undefined : t('export.mediaPending')}
          >
            <Package className="w-4 h-4 text-gray-400 shrink-0" />
            <div>
              <div>{t('export.resourcePack')}</div>
              <div className="text-[11px] text-gray-400 dark:text-gray-500">
                {t('export.resourcePackDesc')}
              </div>
            </div>
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!canExport || isExportingZip}
            onSelect={exportClassroomZip}
            className="cursor-pointer gap-2.5"
            title={canExport ? undefined : t('export.mediaPending')}
          >
            <Archive className="w-4 h-4 text-gray-400 shrink-0" />
            <div>
              <div>{t('export.classroomZip')}</div>
              <div className="text-[11px] text-gray-400 dark:text-gray-500">
                {t('export.classroomZipDesc')}
              </div>
            </div>
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger
              disabled={!canExport}
              title={canExport ? undefined : t('export.mediaPending')}
              className="cursor-pointer gap-2.5"
            >
              <NotebookText className="w-4 h-4 text-gray-400 shrink-0" aria-hidden="true" />
              <span>{t('export.script')}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-[240px]">
              <DropdownMenuItem
                disabled={!canExport || isExportingScript}
                onSelect={exportScriptMd}
                className="cursor-pointer gap-2.5"
              >
                <NotebookText className="w-4 h-4 text-gray-400 shrink-0" aria-hidden="true" />
                <div>
                  <div>{t('export.scriptMd')}</div>
                  <div className="text-[11px] text-gray-400 dark:text-gray-500">
                    {t('export.scriptMdDesc')}
                  </div>
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!canExport || isExportingScript}
                onSelect={exportScriptDocx}
                className="cursor-pointer gap-2.5"
              >
                <NotebookText
                  className="w-4 h-4 text-gray-400 dark:text-gray-500"
                  aria-hidden="true"
                />
                <div>
                  <div>{t('export.scriptDocx')}</div>
                  <div className="text-[11px] text-gray-400 dark:text-gray-500">
                    {t('export.scriptDocxDesc')}
                  </div>
                </div>
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {videoExportEnabled && (
            <DropdownMenuItem
              disabled={!canExport}
              onSelect={() => setVideoDialogOpen(true)}
              className="cursor-pointer gap-2.5 border-t border-gray-200 dark:border-gray-700"
              title={canExport ? undefined : t('export.mediaPending')}
            >
              <Film className="w-4 h-4 text-gray-400 shrink-0" />
              <div>
                <div>{t('export.video')}</div>
                <div className="text-[11px] text-gray-400 dark:text-gray-500">
                  {t('export.videoDesc')}
                </div>
              </div>
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      {videoExportEnabled && (
        <VideoExportDialog open={videoDialogOpen} onOpenChange={setVideoDialogOpen} />
      )}
    </div>
  );
}
```

---

## WorkspaceShell — `components/workbench/workspace/WorkspaceShell.tsx`

~1255 lines. Pro `/workspace` chrome: full-viewport `.ws-root` with optional rail, chat pane, classroom pane, reopen tabs, or `WorkspaceHome`. No global header. Query mirrors panes (`?session=`, `?course=`).

Key chrome JSX (controller return):

```tsx
  return (
    <div
      ref={rootRef}
      data-testid="pro-workspace"
      data-ws-layout={
        render.home ? 'home' : `${chatOpen ? 'chat' : ''}${classroomOpen ? 'classroom' : ''}`
      }
      className="ws-root flex h-[100dvh] w-full overflow-hidden"
      // The default only — the persisted width is applied to this same
      // variable in a layout effect, so server and client markup agree.
      style={{ ['--ws-rail-w' as string]: `${RAIL_WIDTH_DEFAULT}px` }}
    >
      {courses.importInput}

      {classroomOpen && playbackOn ? null : (
        <WorkspaceRail
          courses={courses}
          sessions={visibleSessions}
          sessionState={sessionState}
          onReloadSessions={() => {
            loadSessions(true);
          }}
          activeCourseId={panes.courseId}
          activeSessionId={panes.sessionId}
          collapsed={collapse.value.nav}
          onToggleCollapsed={collapse.toggleNav}
          onOpenCourse={openCourse}
          onOpenSession={openSession}
          onNewSession={startNewConversation}
          onGoHome={goHome}
          onExitPro={exitPro}
          onSessionDeleted={handleSessionDeleted}
          onRenameSession={renameSession}
          onDeleteCourse={handleCourseDeleted}
          resizeHandle={
            <ResizeHandle
              testId="pro-rail-resize-handle"
              label={t('workspace.resizeAria')}
              edge="right"
              current={railWidth.current}
              clamp={clampRailWidth}
              onPreview={railWidth.preview}
              onCommit={railWidth.commit}
              onReset={railWidth.reset}
            />
          }
        />
      )}

      {chatTab ? (
        <PaneTab
          testId="workspace-chat-reopen"
          label={t('workspace.expandChat')}
          onClick={focusChat}
        />
      ) : null}

      {chatOpen || chatMounted ? (
        <WorkspaceChatPane
          hidden={!chatOpen}
          fill={chatFills}
          width={chatWidth.value}
          navigation={courseNavigation}
          draftConversation={draftConversation}
          onRename={
            attachedSessionId
              ? (title: string) => renameSession(attachedSessionId, title)
              : undefined
          }
          onCollapse={bothPanesOnScreen ? collapse.collapseChat : undefined}
          resizeHandle={
            bothPanesOnScreen ? (
              <ResizeHandle
                testId="workspace-chat-resize-handle"
                label={t('workspace.resizeChatAria')}
                edge="right"
                current={chatWidth.current}
                clamp={clampChatWidth}
                onPreview={chatWidth.preview}
                onCommit={chatWidth.commit}
                onReset={chatWidth.reset}
              />
            ) : undefined
          }
        />
      ) : null}

      {panes.courseId ? (
        <WorkspaceClassroomPane
          browser={classroomBrowser}
          hidden={!classroomOpen}
          readOnly={readOnlyCourse}
          playback={playbackOn}
          onCollapse={bothPanesOnScreen ? collapse.collapseClassroom : undefined}
        />
      ) : null}

      {classroomTab ? (
        <PaneTab
          testId="workspace-classroom-reopen"
          label={t('workspace.expandClassroom')}
          side="right"
          onClick={focusClassroom}
        />
      ) : null}

      {render.home ? (
        <WorkspaceHome
          composerReset={composerReset}
          discoveryContent={courses.discoveryContent}
          courseOptions={courseOptions}
          onOpenSession={openCreatedSession}
          onExitPro={exitPro}
        />
      ) : null}
    </div>
  );
```

---

## SceneSidebar chrome — `components/stage/scene-sidebar.tsx`

Collapsible left rail. Logo header + numbered scene list. Width 170–400 (default 220).

```tsx
  return (
    <div
      style={{
        width: displayWidth,
        transition: isDraggingRef.current ? 'none' : 'width 0.3s ease',
      }}
      className="bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl border-r border-gray-100 dark:border-gray-800 shadow-[2px_0_24px_rgba(0,0,0,0.02)] flex flex-col shrink-0 z-20 relative overflow-visible"
    >
      {/* Drag handle */}
      {!collapsed && (
        <div
          onMouseDown={handleDragStart}
          className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize z-50 group hover:bg-purple-400/30 dark:hover:bg-purple-600/30 active:bg-purple-500/40 dark:active:bg-purple-500/40 transition-colors"
        >
          <div className="absolute right-0.5 top-1/2 -translate-y-1/2 w-0.5 h-8 rounded-full bg-gray-300 dark:bg-gray-600 group-hover:bg-purple-400 dark:group-hover:bg-purple-500 transition-colors" />
        </div>
      )}

      <div className={cn('flex flex-col w-full h-full overflow-hidden', collapsed && 'hidden')}>
        {/* Logo Header */}
        <div className="h-10 flex items-center justify-between shrink-0 relative mt-3 mb-1 px-3">
          <button
            onClick={() => router.push('/')}
            className="flex items-center gap-2 cursor-pointer rounded-lg px-1.5 -mx-1.5 py-1 -my-1 hover:bg-gray-100/80 dark:hover:bg-gray-800/60 active:scale-[0.97] transition-all duration-150"
            title={t('generation.backToHome')}
          >
            <img src="/logo-horizontal.png" alt="OpenMAIC" className="h-6" />
          </button>
          <button
            onClick={() => onCollapseChange(true)}
            className="w-7 h-7 shrink-0 rounded-lg flex items-center justify-center bg-gray-100/80 dark:bg-gray-800/80 text-gray-500 dark:text-gray-400 ring-1 ring-black/[0.04] dark:ring-white/[0.06] hover:bg-gray-200/90 dark:hover:bg-gray-700/90 hover:text-gray-700 dark:hover:text-gray-200 active:scale-90 transition-all duration-200"
          >
            <PanelLeftClose className="w-4 h-4" />
          </button>
        </div>

        {/* Scenes List */}
        <div
          data-testid="scene-list"
          className="flex-1 overflow-y-auto overflow-x-hidden p-2 space-y-2 scrollbar-hide pt-1"
        >
          {scenes.map((scene, index) => {
            const isActive = currentSceneId === scene.id;
            const Icon = getSceneTypeIcon(scene.type);
            // ...
            return (
              <div
                key={scene.id}
                data-testid="scene-item"
                onClick={() => {
                  if (onSceneSelect) {
                    onSceneSelect(scene.id);
                  } else {
                    setCurrentSceneId(scene.id);
                  }
                }}
                className={cn(
                  'group relative rounded-lg transition-all duration-200 cursor-pointer flex flex-col gap-1 p-1.5',
                  isActive
                    ? 'bg-purple-50 dark:bg-purple-900/20 ring-1 ring-purple-200 dark:ring-purple-700'
                    : 'hover:bg-gray-50/80 dark:hover:bg-gray-800/50',
                )}
              >
                <div className="flex justify-between items-center px-2 pt-0.5">
                  <div className="flex items-center gap-2 max-w-full">
                    <span
                      className={cn(
                        'text-[10px] font-black w-4 h-4 rounded-full flex items-center justify-center shrink-0',
                        isActive
                          ? 'bg-purple-600 dark:bg-purple-500 text-white shadow-sm shadow-purple-500/30'
                          : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400',
                      )}
                    >
                      {index + 1}
                    </span>
                    <span
                      data-testid="scene-title"
                      className={cn(
                        'text-xs font-bold truncate transition-colors',
                        isActive
                          ? 'text-purple-700 dark:text-purple-300'
                          : 'text-gray-600 dark:text-gray-300 group-hover:text-gray-900 dark:group-hover:text-gray-100',
                      )}
                    >
                      {scene.title}
                    </span>
                  </div>
                </div>
                {/* Thumbnail: slide / quiz grid / interactive iframe or chrome */}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
```
