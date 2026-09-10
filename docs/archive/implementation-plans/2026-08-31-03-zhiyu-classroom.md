# ZHIYU Classroom Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the standalone classroom presentation into Scene Rail + Learning Stage + Interaction Panel + Playback Bar while preserving the existing PlaybackEngine, Stage mode dispatch, Chat/TTS behavior, scene navigation guards, editor entry, and hosted Workspace behavior.

**Architecture:** `Stage` continues to decide edit/playback chrome. `PlaybackChromeRoot` remains the owner of playback/chat state and existing handlers. Add presentation-only classroom shell components and pass the already-computed state/handlers into them. Do not move PlaybackEngine or chat lifecycle into the new components.

**Tech Stack:** React 19, TypeScript, Zustand, existing PlaybackEngine/ActionEngine/ChatArea/Roundtable, Tailwind CSS 4, Playwright, Vitest.

**Spec:** `zhiyu-implementation-plans/2026-08-31-zhiyu-full-ui-redesign-v2.md`

## Global Constraints

- Keep `Stage` mode dispatch semantics unchanged.
- Keep `PlaybackChromeRootHandle.teardown(): Promise<void>` unchanged.
- Keep scene-switch confirmation and unsafe-navigation guards unchanged.
- Keep TTS, audio player, SSE/chat teardown, playback cursor, action resume, whiteboard, presentation mode, and Pro-mode entry behavior unchanged.
- Hosted Workspace classroom must still suppress chrome owned by the host.
- Interaction Panel may reorganize Chat/participants visually but must not create a second Chat lifecycle.
- Generated slide content keeps its own colors.
- No purple brand play glow; ZHIYU green is primary, AI blue/lavender are semantic accents.

---

## File Structure

**Create**
- `components/classroom/ZhiyuClassroomShell.tsx` — responsive four-region layout.
- `components/classroom/ZhiyuInteractionPanel.tsx` — tabs/presentation for lecture, discussion, roles.
- `components/classroom/ZhiyuPlaybackBar.tsx` — presentation for existing playback controls.
- `components/classroom/zhiyu-classroom-layout.ts` — pure responsive/layout decisions if needed.
- `tests/classroom/zhiyu-classroom-layout.test.ts` — pure layout tests.
- `e2e/tests/zhiyu-classroom-ui.spec.ts` — structural and behavior-preservation assertions.

**Modify**
- `components/edit/PlaybackChromeRoot.tsx` — wire existing state/handlers into new shell.
- `components/header.tsx` — ZHIYU standalone header presentation.
- `components/stage/header-controls.tsx` — regroup actions, same handlers.
- `components/stage/scene-sidebar.tsx` — collapsed/expanded ZHIYU rail presentation.
- `components/stage/scene-thumbnail-content.tsx` — thumbnail/meta skin.
- `components/canvas/canvas-area.tsx` only if outer stage spacing is owned there; do not alter renderer content.
- `components/classroom/ClassroomSurface.tsx` — loading/not-found/error presentation only.
- existing classroom E2E/page objects as needed.

---

### Task 1: Define the new classroom DOM contract before changing layout

**Files:**
- Create: `e2e/tests/zhiyu-classroom-ui.spec.ts`

**Interfaces:**
- Produces required test IDs:
  - `zhiyu-classroom-shell`
  - `zhiyu-scene-rail`
  - `zhiyu-learning-stage`
  - `zhiyu-interaction-panel`
  - `zhiyu-playback-bar`

- [ ] **Step 1: Seed/reuse the existing classroom E2E fixture**

Use the same generated/stored classroom fixture pattern already used by `e2e/tests/classroom-interaction.spec.ts`; do not add production-only test branches.

- [ ] **Step 2: Write the failing structural test**

```ts
test('renders the ZHIYU classroom workspace regions', async ({ page }) => {
  // Navigate using the same seeded classroom helper used by existing classroom tests.

  await expect(page.getByTestId('zhiyu-classroom-shell')).toBeVisible();
  await expect(page.getByTestId('zhiyu-scene-rail')).toBeVisible();
  await expect(page.getByTestId('zhiyu-learning-stage')).toBeVisible();
  await expect(page.getByTestId('zhiyu-interaction-panel')).toBeVisible();
  await expect(page.getByTestId('zhiyu-playback-bar')).toBeVisible();
});
```

- [ ] **Step 3: Add behavior-preservation assertions**

Use accessible names/selectors already exposed by current controls to assert:
- next scene still changes current scene
- play/pause still invokes the existing behavior
- Chat panel remains reachable
- edit/Pro entry remains reachable when enabled

Do not assert CSS class names.

- [ ] **Step 4: Run and verify failure**

```bash
pnpm exec playwright test e2e/tests/zhiyu-classroom-ui.spec.ts
```

Expected: FAIL because the ZHIYU regions do not exist.

- [ ] **Step 5: Commit failing contract**

```bash
git add e2e/tests/zhiyu-classroom-ui.spec.ts
git commit -m "test(classroom): define zhiyu classroom UI contract"
```

---

### Task 2: Build the layout shell without moving playback state

**Files:**
- Create: `components/classroom/ZhiyuClassroomShell.tsx`
- Modify: `components/edit/PlaybackChromeRoot.tsx`

**Interfaces:**
- `ZhiyuClassroomShell` accepts React slots:

```ts
export type ZhiyuClassroomShellProps = {
  header: ReactNode;
  sceneRail: ReactNode;
  stage: ReactNode;
  interaction: ReactNode;
  playbackBar: ReactNode;
  interactionCollapsed: boolean;
  sceneRailCollapsed: boolean;
};
```

- [ ] **Step 1: Implement the shell as layout only**

Root:

```tsx
<div
  data-testid="zhiyu-classroom-shell"
  className="grid h-full min-h-0 ..."
>
```

The shell must not import:
- `PlaybackEngine`
- `ActionEngine`
- Stage store
- Chat hooks

It only renders slots.

- [ ] **Step 2: Wire existing `PlaybackChromeRoot` regions into slots**

Keep all existing state and handlers in `PlaybackChromeRoot`; replace only the outer JSX composition.

Example shape:

```tsx
<ZhiyuClassroomShell
  header={/* existing Header props */}
  sceneRail={/* existing SceneSidebar props */}
  stage={/* existing CanvasArea + overlays */}
  interaction={/* existing Chat/Roundtable content, reorganized in later task */}
  playbackBar={/* current controls, reorganized in later task */}
  interactionCollapsed={chatAreaCollapsed}
  sceneRailCollapsed={sidebarCollapsed}
/>
```

- [ ] **Step 3: Preserve hosted-header flags**

All existing:
- `hideHeader`
- `hideHeaderBackControl`
- `hideHeaderGlobalControls`
- `hideHeaderCourseActions`

must still flow through the standalone/hosted rendering path exactly as before.

- [ ] **Step 4: Run current classroom interaction test**

```bash
pnpm exec playwright test e2e/tests/classroom-interaction.spec.ts
```

Expected: PASS or fail only on selectors intentionally changed; fix selectors, not behavior.

- [ ] **Step 5: Commit**

```bash
git add components/classroom/ZhiyuClassroomShell.tsx components/edit/PlaybackChromeRoot.tsx
git commit -m "feat(classroom): add zhiyu classroom layout shell"
```

---

### Task 3: Redesign SceneSidebar into the ZHIYU Scene Rail

**Files:**
- Modify: `components/stage/scene-sidebar.tsx`
- Modify: `components/stage/scene-thumbnail-content.tsx`
- Test: `e2e/tests/zhiyu-classroom-ui.spec.ts`

**Interfaces:**
- Existing scene selection callback and collapsed state stay unchanged.
- Add root `data-testid="zhiyu-scene-rail"`.

- [ ] **Step 1: Add failing current-scene assertion**

```ts
const rail = page.getByTestId('zhiyu-scene-rail');
await expect(rail).toBeVisible();
await expect(rail.locator('[aria-current="page"]')).toHaveCount(1);
```

- [ ] **Step 2: Preserve event wiring**

Do not change the callback that ultimately requests scene switching. The new rail button must invoke the existing scene-change path so unsafe navigation confirmation still works.

- [ ] **Step 3: Implement collapsed rail**

Target:
- ~72px
- scene number/compact thumbnail
- current scene uses `aria-current="page"`
- ZHIYU green soft background + non-color cue (left bar/bold label)
- no purple active classes

- [ ] **Step 4: Implement expanded rail**

Target:
- ~232px
- thumbnail + scene number/title
- generated thumbnail colors untouched

- [ ] **Step 5: Run interaction and navigation tests**

```bash
pnpm exec playwright test e2e/tests/zhiyu-classroom-ui.spec.ts e2e/tests/classroom-interaction.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add components/stage/scene-sidebar.tsx components/stage/scene-thumbnail-content.tsx e2e/tests/zhiyu-classroom-ui.spec.ts
git commit -m "feat(classroom): redesign scene navigation rail"
```

---

### Task 4: Reframe the Learning Stage

**Files:**
- Modify: `components/edit/PlaybackChromeRoot.tsx`
- Modify: `components/canvas/canvas-area.tsx` only if required by ownership of outer spacing.
- Test: `e2e/tests/zhiyu-classroom-ui.spec.ts`

**Interfaces:**
- Generated scene renderer and scale calculations remain unchanged.
- Root wrapper gets `data-testid="zhiyu-learning-stage"`.

- [ ] **Step 1: Add failing learning-stage assertion**

```ts
await expect(page.getByTestId('zhiyu-learning-stage')).toBeVisible();
```

- [ ] **Step 2: Move product spacing outside the generated renderer**

Apply:
- neutral learning canvas
- 20–28px desktop breathing space
- subtle outer radius/shadow

Do not apply inherited color filters/background overlays to the rendered slide content.

- [ ] **Step 3: Replace purple play overlay presentation**

Keep the existing click handler. Change only:
- surface
- icon color
- shadow
- hover state

- [ ] **Step 4: Run slide-content E2E**

```bash
pnpm exec playwright test e2e/tests/slide-content-surface-647.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add components/edit/PlaybackChromeRoot.tsx components/canvas/canvas-area.tsx e2e/tests/zhiyu-classroom-ui.spec.ts
git commit -m "style(classroom): reframe the learning stage"
```

---

### Task 5: Build the Interaction Panel around existing Chat and participant state

**Files:**
- Create: `components/classroom/ZhiyuInteractionPanel.tsx`
- Modify: `components/edit/PlaybackChromeRoot.tsx`
- Test: `e2e/tests/classroom-interaction.spec.ts`
- Test: `e2e/tests/zhiyu-classroom-ui.spec.ts`

**Interfaces:**
- Inputs are already-computed values from `PlaybackChromeRoot`, not store reads hidden in the panel:

```ts
type ZhiyuInteractionPanelProps = {
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  lectureContent: ReactNode;
  discussionContent: ReactNode;
  rolesContent: ReactNode;
  liveStatus: 'idle' | 'teaching' | 'thinking' | 'discussion';
};
```

- [ ] **Step 1: Add tab-presence test**

```ts
const panel = page.getByTestId('zhiyu-interaction-panel');
await expect(panel.getByRole('tab', { name: /讲解|lecture/i })).toBeVisible();
await expect(panel.getByRole('tab', { name: /讨论|discussion/i })).toBeVisible();
await expect(panel.getByRole('tab', { name: /角色|roles/i })).toBeVisible();
```

- [ ] **Step 2: Build panel presentation**

Use accessible tab semantics:
- `role="tablist"`
- `role="tab"`
- `aria-selected`

Tabs switch presentation only; they do not start/stop Chat or Playback.

- [ ] **Step 3: Reuse existing ChatArea instance**

The discussion tab must render the same `ChatArea` instance/ref currently owned by `PlaybackChromeRoot`. Do not mount a duplicate hidden ChatArea for another tab.

- [ ] **Step 4: Reuse current participant/roundtable data**

Map existing:
- speaking agent
- thinking state
- selected agents
- audio indicator

into the Roles/lecture presentation. Do not add another agent registry subscription if the data is already available in the parent.

- [ ] **Step 5: Preserve collapse persistence**

Use existing `chatAreaCollapsed` and `setChatAreaCollapsed`; do not invent another persisted key.

- [ ] **Step 6: Run chat/classroom E2E**

```bash
pnpm exec playwright test e2e/tests/classroom-interaction.spec.ts e2e/tests/zhiyu-classroom-ui.spec.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add components/classroom/ZhiyuInteractionPanel.tsx components/edit/PlaybackChromeRoot.tsx e2e/tests/
git commit -m "feat(classroom): add zhiyu classroom interaction panel"
```

---

### Task 6: Consolidate playback controls into a bottom bar

**Files:**
- Create: `components/classroom/ZhiyuPlaybackBar.tsx`
- Modify: `components/edit/PlaybackChromeRoot.tsx`
- Modify: `components/stage/header-controls.tsx` to remove duplicate controls only after bottom-bar equivalents are wired.

**Interfaces:**
- `ZhiyuPlaybackBar` receives existing callbacks and state; no PlaybackEngine import.

```ts
type ZhiyuPlaybackBarProps = {
  currentIndex: number;
  total: number;
  playing: boolean;
  canPrevious: boolean;
  canNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onTogglePlay: () => void;
  onReplay?: () => void;
  onEdit?: () => void;
  onPresent?: () => void;
};
```

- [ ] **Step 1: Add failing bar test**

```ts
const bar = page.getByTestId('zhiyu-playback-bar');
await expect(bar).toBeVisible();
await expect(bar.getByRole('button', { name: /播放|play|暂停|pause/i })).toBeVisible();
```

- [ ] **Step 2: Implement presentation component**

Use `aria-label`s for icon-only previous/next/replay/fullscreen controls.

- [ ] **Step 3: Wire the exact existing handlers**

Do not call `setCurrentSceneId` directly from the new component if the old UI used a guarded request function. Pass that guarded handler instead.

- [ ] **Step 4: Remove only duplicate visual controls**

Once the bottom bar is live, remove duplicate play/prev/next visuals from their old containers; do not delete their handler definitions.

- [ ] **Step 5: Run navigation/playback tests**

```bash
pnpm exec playwright test e2e/tests/zhiyu-classroom-ui.spec.ts e2e/tests/classroom-interaction.spec.ts e2e/tests/full-happy-path.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add components/classroom/ZhiyuPlaybackBar.tsx components/edit/PlaybackChromeRoot.tsx components/stage/header-controls.tsx e2e/tests/
git commit -m "feat(classroom): consolidate playback controls"
```

---

### Task 7: Simplify standalone Classroom Header

**Files:**
- Modify: `components/header.tsx`
- Modify: `components/stage/header-controls.tsx`

**Interfaces:**
- Existing back/share/export/settings/language handlers remain unchanged.
- Hosted hide flags remain unchanged.

- [ ] **Step 1: Write header structure assertion**

```ts
await expect(page.getByRole('banner')).toContainText(/智域|ZHIYU/);
await expect(page.getByText(/CURRENT SCENE/i)).toHaveCount(0);
```

- [ ] **Step 2: Recompose header**

Left:
- brand mark/lockup if standalone
- back
- course title

Right:
- share
- export
- language
- settings
- page-specific actions only

Remove duplicate `CURRENT SCENE` label from presentation.

- [ ] **Step 3: Verify hosted Workspace suppression**

Run existing workbench/classroom tests that exercise hosted playback.

- [ ] **Step 4: Commit**

```bash
git add components/header.tsx components/stage/header-controls.tsx e2e/tests/zhiyu-classroom-ui.spec.ts
git commit -m "feat(classroom): simplify zhiyu classroom header"
```

---

### Task 8: Redesign loading, not-found, and error states

**Files:**
- Modify: `components/classroom/ClassroomSurface.tsx`
- Test: existing classroom load/error tests if present; add E2E only when deterministic.

**Interfaces:**
- Load/retry/not-found state machine remains untouched.
- Only returned JSX for those states changes.

- [ ] **Step 1: Keep existing branch order**

Do not change:
- loading condition
- `notFound` terminal semantics
- error retry semantics
- pane availability retry behavior

- [ ] **Step 2: Replace presentation**

Use:
- ZHIYU mark
- approved neutral canvas
- `正在载入课堂…`
- not found: `课程不在这里`
- action: `返回智域`

The existing Link/retry callbacks remain.

- [ ] **Step 3: Run classroom load-related unit/E2E tests**

Run relevant test set plus:

```bash
pnpm exec playwright test e2e/tests/full-happy-path.spec.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add components/classroom/ClassroomSurface.tsx
git commit -m "style(classroom): unify loading and error states"
```

---

### Task 9: Classroom P0 verification gate

- [ ] **Step 1: Run targeted unit tests**

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 2: Run classroom E2E**

```bash
pnpm exec playwright test \
  e2e/tests/zhiyu-classroom-ui.spec.ts \
  e2e/tests/classroom-interaction.spec.ts \
  e2e/tests/slide-content-surface-647.spec.ts \
  e2e/tests/full-happy-path.spec.ts
```

Expected: PASS.

- [ ] **Step 3: Run production checks**

```bash
pnpm lint
pnpm check:i18n-keys
pnpm build
```

Expected: PASS.

- [ ] **Step 4: Manual 1440px regression**

Verify:
- scene rail collapse/expand
- interaction collapse/expand
- current scene selection
- play/pause
- previous/next
- lecture TTS
- discussion send
- roles status
- edit/Pro entry
- share/export/settings
- generated slide colors unchanged
- no purple product play glow

- [ ] **Step 5: Manual hosted Workspace regression**

Open a classroom inside the Pro Workspace pane and confirm:
- host-owned header is not duplicated
- classroom does not gain standalone Home/back chrome unexpectedly
- edit/playback transitions do not flash the wrong shell

- [ ] **Step 6: Commit verification fixes if any**

```bash
git add -A
git commit -m "fix(classroom): resolve zhiyu classroom verification issues"
```
