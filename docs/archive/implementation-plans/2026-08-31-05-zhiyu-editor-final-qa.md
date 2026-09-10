# ZHIYU Editor + Final QA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish ZHIYU consistency in editor/secondary chrome, then run a release-level regression and competition demo gate.

**Architecture:** Editor work is presentation-only: preserve editor model, canvas, save/undo/redo and Stage mode behavior. After polish, freeze feature work and use the existing Vitest/Playwright suite plus a deterministic manual demo script as the final release gate.

**Tech Stack:** Existing OpenMAIC editor modules, React 19, TypeScript, Tailwind CSS 4, Vitest, Playwright.

**Spec:** `zhiyu-implementation-plans/2026-08-31-zhiyu-full-ui-redesign-v2.md`

## Global Constraints

- Start only after P0 and P1 are green.
- Do not restructure editor domain state.
- Do not introduce new editor capability for visual completeness.
- Secondary dialogs follow ZHIYU tokens but are lower priority than correctness.
- Dark mode/responsive work fixes broken states; it does not trigger a second redesign.
- Final release requires all commands and manual demo steps to pass.

---

### Task 1: Add editor-shell visual contract

**Files:**
- Create: `e2e/tests/zhiyu-editor-ui.spec.ts`
- Modify editor presentation files only after the failing test exists.

**Interfaces:**
- Stable root ID: `zhiyu-editor-shell`.

- [ ] **Step 1: Write failing E2E**

Enter edit mode through the same user path used by existing editor E2E and assert:

```ts
await expect(page.getByTestId('zhiyu-editor-shell')).toBeVisible();
```

Also assert existing Undo/Redo/Preview/Done controls remain reachable by their accessible names.

- [ ] **Step 2: Run and verify failure**

```bash
pnpm exec playwright test e2e/tests/zhiyu-editor-ui.spec.ts
```

- [ ] **Step 3: Commit**

```bash
git add e2e/tests/zhiyu-editor-ui.spec.ts
git commit -m "test(editor): define zhiyu editor chrome contract"
```

---

### Task 2: Apply ZHIYU chrome to the editor without touching canvas behavior

**Files:**
- Modify the editor chrome/root components currently mounted by `EditChromeRoot`.
- Modify shared edit command bar/panel presentation files as needed.
- Do not modify persisted editor document/schema logic.

**Interfaces:**
- `Stage` edit/playback dispatch unchanged.
- Undo/redo/save/preview callbacks unchanged.

- [ ] **Step 1: Add `zhiyu-editor-shell` to the editor root**

Do not add another nested full-screen layout that would alter canvas sizing.

- [ ] **Step 2: Recompose header/panels**

Target hierarchy:

```text
Header / command bar
Scene rail | Canvas | Properties
```

Use:
- neutral canvas
- grouped controls
- Green active states
- calm panel separators

- [ ] **Step 3: Preserve canvas scale/measurement**

Run any existing editor/canvas tests immediately after layout changes.

- [ ] **Step 4: Run editor E2E**

```bash
pnpm exec playwright test e2e/tests/zhiyu-editor-ui.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add components/edit e2e/tests/zhiyu-editor-ui.spec.ts
git commit -m "style(editor): align editor chrome with zhiyu"
```

---

### Task 3: Secondary dialogs and export surfaces

**Files:**
- Modify presentation only in:
  - `components/stage/video-export-dialog.tsx`
  - share/export dialogs actually reachable in competition demo
  - other secondary dialogs only if visibly inconsistent

**Interfaces:**
- Export/share handlers and payloads unchanged.

- [ ] **Step 1: Inventory only visible competition-path dialogs**

Do not style every unused internal dialog. The allowed set is the dialogs reachable from:
- Classroom share/export
- Settings
- Editor completion
- video export if enabled in demo

- [ ] **Step 2: Apply ZHIYU surface/token hierarchy**

Keep:
- current Dialog primitives
- current focus trap
- current action callbacks
- current destructive confirmations

- [ ] **Step 3: Run targeted export/share tests**

Use existing tests; if no E2E exists, manually exercise the dialog open/cancel path without invoking expensive external rendering.

- [ ] **Step 4: Commit**

```bash
git add components/stage components/ui
git commit -m "style(ui): align competition dialogs with zhiyu"
```

---

### Task 4: Responsive and dark-mode breakage pass

**Files:**
- Modify only styles/components with demonstrated breakage.

**Interfaces:**
- No new feature behavior.

- [ ] **Step 1: Check desktop widths**

Manually verify:
- 1366
- 1440
- 1512
- 1600

Fix only clipping, unusable panels, overflow, or action collisions.

- [ ] **Step 2: Check 1024–1280 classroom**

Required:
- interaction panel can collapse
- Stage remains usable
- playback bar remains visible

- [ ] **Step 3: Check below 900**

Required:
- Scene rail and interaction content remain reachable through existing/new drawer/sheet presentation
- no horizontal page overflow

- [ ] **Step 4: Check system dark mode**

Required:
- readable text
- visible focus
- no hardcoded white-on-white or black-on-black
- generated slide content not filtered/recolored

- [ ] **Step 5: Commit**

```bash
git add app components
git commit -m "fix(ui): harden zhiyu responsive and dark states"
```

---

### Task 5: Full automated release gate

**Files:**
- No feature work; fix regressions only.

- [ ] **Step 1: Run formatting/checks**

```bash
pnpm check
pnpm lint
pnpm check:i18n-keys
pnpm check:package-versions
```

Expected: PASS. If `check:package-versions` is intentionally not applicable to this branch's workflow, document the exact repository reason in the PR; do not silently skip it.

- [ ] **Step 2: Run all unit tests**

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 3: Run core E2E path**

```bash
pnpm exec playwright test \
  e2e/tests/home-to-generation.spec.ts \
  e2e/tests/generation-flow.spec.ts \
  e2e/tests/classroom-interaction.spec.ts \
  e2e/tests/full-happy-path.spec.ts \
  e2e/tests/zhiyu-home-ui.spec.ts \
  e2e/tests/zhiyu-generation-ui.spec.ts \
  e2e/tests/zhiyu-classroom-ui.spec.ts \
  e2e/tests/zhiyu-workspace-ui.spec.ts \
  e2e/tests/zhiyu-settings-ui.spec.ts \
  e2e/tests/zhiyu-editor-ui.spec.ts
```

Expected: PASS.

- [ ] **Step 4: Run production build**

```bash
pnpm build
```

Expected: PASS.

- [ ] **Step 5: Commit regression fixes only if necessary**

```bash
git add -A
git commit -m "fix(ui): resolve final zhiyu regression failures"
```

---

### Task 6: Manual competition demo gate

**Files:**
- Create: `docs/zhiyu-demo-checklist.md`

**Interfaces:**
- Produces the final repeatable demo script.

- [ ] **Step 1: Create this exact checklist**

```md
# ZHIYU Competition Demo Checklist

- [ ] Open Home at desktop demo resolution.
- [ ] Confirm ZHIYU lockup and no academy/青衿 remnants.
- [ ] Enter a real course prompt.
- [ ] Toggle/material controls used in the demo.
- [ ] Start class.
- [ ] Observe truthful Generation Preview states.
- [ ] Open outline review if the demo enables it; close/confirm normally.
- [ ] Enter Classroom.
- [ ] Change Scene forward and backward.
- [ ] Start and pause playback.
- [ ] Trigger or listen to TTS.
- [ ] Open Classroom Interaction.
- [ ] Send one Chat message.
- [ ] Inspect Roles state.
- [ ] Collapse and reopen the Interaction Panel.
- [ ] Expand/collapse Scene Rail.
- [ ] Enter Edit mode.
- [ ] Return to Playback.
- [ ] Open Settings and change/save one safe setting.
- [ ] Open Share/Export dialog and cancel cleanly.
- [ ] Return Home.
- [ ] Reopen the generated course from history.
- [ ] Confirm no generated slide is recolored by product chrome.
```

- [ ] **Step 2: Run the checklist twice**

First pass: developer.  
Second pass: someone who did not implement the redesign, if available.

- [ ] **Step 3: Record demo blockers as issues, not new features**

Only fix:
- broken functionality
- clipping
- missing labels
- unstable transitions
- obvious original-OpenMAIC purple/branding leaks on the demo path

Do not add new features during final QA.

- [ ] **Step 4: Commit checklist**

```bash
git add docs/zhiyu-demo-checklist.md
git commit -m "docs: add zhiyu competition demo checklist"
```

---

### Task 7: Final release decision

- [ ] **Step 1: Confirm git diff scope**

Ensure no unintended edits to:
- generation pipeline
- orchestration
- playback engine logic
- storage schemas
- provider implementations
- Chat lifecycle

- [ ] **Step 2: Confirm licenses remain**

Keep upstream project and third-party license files intact.

- [ ] **Step 3: Tag the competition-ready checkpoint using the team's normal Git workflow**

Do not invent a deployment/tagging convention in code if the project does not already have one.

- [ ] **Step 4: Stop feature work**

Once the demo checklist and automated gate are green, move to deployment/stability only.
