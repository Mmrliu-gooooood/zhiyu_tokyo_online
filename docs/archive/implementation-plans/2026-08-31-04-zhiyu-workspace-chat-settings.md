# ZHIYU Workspace + Chat + Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the stable P0 ZHIYU visual system into Workspace, Chat, and Settings without changing Workbench navigation/session behavior, Chat lifecycle, provider configuration, or settings persistence.

**Architecture:** Treat Workspace, Chat, and Settings as three presentation subsystems sharing global tokens but not new shared business state. Reuse the exact existing stores/hooks; add presentation wrappers only where a large component benefits from isolation.

**Tech Stack:** React 19, TypeScript, Zustand, Tailwind CSS 4, Radix/shadcn, existing Workbench/Chat/Settings modules, Vitest, Playwright.

**Spec:** `zhiyu-implementation-plans/2026-08-31-zhiyu-full-ui-redesign-v2.md`

## Global Constraints

- Start only after Plans 01–03 pass their P0 verification gates.
- Do not modify `components/chat/use-chat-sessions.ts` business behavior.
- Do not change Workspace pane/session/course routing semantics.
- Do not change Settings store schema, provider save/delete semantics, or API-key handling.
- Use real data only; no fake learning dashboard metrics.
- Workspace and Settings are calmer than Home; illustration is not required.

---

### Task 1: Add Workspace visual-contract E2E coverage

**Files:**
- Create: `e2e/tests/zhiyu-workspace-ui.spec.ts`

**Interfaces:**
- Required stable regions:
  - `zhiyu-workspace-shell`
  - `zhiyu-workspace-rail`
  - existing session/course pane IDs continue if already stable

- [ ] **Step 1: Write failing shell assertions**

```ts
await expect(page.getByTestId('zhiyu-workspace-shell')).toBeVisible();
await expect(page.getByTestId('zhiyu-workspace-rail')).toBeVisible();
```

Seed/open Workspace using existing E2E fixture conventions.

- [ ] **Step 2: Run and verify failure**

```bash
pnpm exec playwright test e2e/tests/zhiyu-workspace-ui.spec.ts
```

- [ ] **Step 3: Commit**

```bash
git add e2e/tests/zhiyu-workspace-ui.spec.ts
git commit -m "test(workspace): define zhiyu workspace UI contract"
```

---

### Task 2: Reskin Workspace shell and rail without changing pane behavior

**Files:**
- Modify: `components/workbench/workspace-shell.css`
- Modify: Workspace shell/rail presentation components under `components/workbench/workspace/`
- Modify: `components/workbench/workspace/WorkspaceHome.tsx`

**Interfaces:**
- Preserve Workbench store and pane IDs/URLs.
- Preserve existing `data-pro-morph` hooks.

- [ ] **Step 1: Replace Workspace visual tokens**

Map workspace-local variables to global ZHIYU roles:
- canvas
- surface
- ink
- line
- accent

Do not keep a second purple brand system.

- [ ] **Step 2: Add shell/rail test IDs**

Apply only to stable structural roots.

- [ ] **Step 3: Recompose rail presentation**

Use:
- 220–240px desktop rail
- ZHIYU lockup
- grouped courses/sessions
- Green Soft active row
- quiet hover
- existing expand/collapse/tree behavior

- [ ] **Step 4: Keep Pro morph anchors**

Do not rename/remove existing `data-pro-morph` values used by transitions.

- [ ] **Step 5: Run Workbench tests**

```bash
pnpm exec vitest run tests/workbench
pnpm exec playwright test e2e/tests/zhiyu-workspace-ui.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add components/workbench e2e/tests/zhiyu-workspace-ui.spec.ts
git commit -m "feat(workspace): apply zhiyu workspace shell"
```

---

### Task 3: Recompose Chat presentation around the existing Chat lifecycle

**Files:**
- Modify: `components/chat/chat-area.tsx`
- Modify: `components/chat/chat-session.tsx`
- Modify: `components/chat/proactive-card.tsx`
- Modify: `components/chat/inline-action-tag.tsx`
- Modify: `components/chat/lecture-notes-view.tsx`
- Do not modify business logic in `components/chat/use-chat-sessions.ts`

**Interfaces:**
- All current `ChatAreaRef` methods and callback props stay unchanged.
- Message/session types stay unchanged.

- [ ] **Step 1: Add/extend Chat UI E2E assertions**

Assert:
- one visible composer
- AI identity + content presentation
- user message can still send
- no duplicate ChatArea mounts

- [ ] **Step 2: Recompose AI messages**

Use:
- avatar/role header
- neutral body
- subtle action/status treatment

Do not wrap every AI response in a large colored bubble.

- [ ] **Step 3: Recompose user messages**

Use right-aligned Green Soft compact surface.

- [ ] **Step 4: Align composer with Home**

Use same:
- radius family
- border/focus language
- button hierarchy

Keep send/microphone/element-reference behavior unchanged.

- [ ] **Step 5: Run Chat tests**

Run existing Chat Vitest set and classroom interaction E2E.

- [ ] **Step 6: Commit**

```bash
git add components/chat
git commit -m "style(chat): align learning conversation with zhiyu"
```

---

### Task 4: Add a Settings navigation/panel contract

**Files:**
- Create: `e2e/tests/zhiyu-settings-ui.spec.ts`
- Modify later: `components/settings/index.tsx`

**Interfaces:**
- Required:
  - `zhiyu-settings-shell`
  - `zhiyu-settings-nav`
  - `zhiyu-settings-content`

- [ ] **Step 1: Write failing E2E test**

Open Settings through the same Home/settings control and assert all three structural IDs.

- [ ] **Step 2: Assert save behavior using a safe non-secret setting**

Choose an existing non-sensitive boolean/select setting from General Settings; change it and assert persistence through the existing store/UI. Do not put API keys in test fixtures.

- [ ] **Step 3: Run and verify failure on new structure**

```bash
pnpm exec playwright test e2e/tests/zhiyu-settings-ui.spec.ts
```

- [ ] **Step 4: Commit**

```bash
git add e2e/tests/zhiyu-settings-ui.spec.ts
git commit -m "test(settings): define zhiyu settings UI contract"
```

---

### Task 5: Rebuild Settings information architecture without changing storage

**Files:**
- Modify: `components/settings/index.tsx`
- Modify presentation components such as:
  - `components/settings/general-settings.tsx`
  - `components/settings/provider-config-panel.tsx`
  - `components/settings/provider-list.tsx`
  - `components/settings/asr-settings.tsx`
  - `components/settings/image-settings.tsx`
  - `components/settings/agent-settings.tsx`

**Interfaces:**
- Current section IDs, Settings store actions, provider actions and dialog callbacks remain unchanged.

- [ ] **Step 1: Recompose the main Dialog into two columns**

Target:
- 900–980px desktop width
- 180–200px nav
- independently scrolling content area
- existing Radix Dialog focus trap retained

- [ ] **Step 2: Group nav labels**

Use existing sections; only change presentation/order when it does not change settings behavior.

Recommended visible group labels:
- 通用
- 模型与服务
- 语音
- 图像
- 智能体
- 文档
- 高级

If the current product lacks one of these sections, do not add a fake empty page.

- [ ] **Step 3: Reduce card nesting**

Prefer section heading + explanation + controls. Reserve cards for complex provider entities.

- [ ] **Step 4: Keep add/edit provider dialogs functional**

Do not change API-key field semantics, save handlers, model lists, or provider IDs.

- [ ] **Step 5: Run Settings E2E and existing tests**

```bash
pnpm exec playwright test e2e/tests/zhiyu-settings-ui.spec.ts e2e/tests/home-to-generation.spec.ts
pnpm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add components/settings e2e/tests/zhiyu-settings-ui.spec.ts
git commit -m "feat(settings): reorganize settings for zhiyu"
```

---

### Task 6: P1 verification gate

- [ ] **Step 1: Run Workbench/Chat/Settings targeted tests**

```bash
pnpm exec vitest run tests/workbench
pnpm exec playwright test \
  e2e/tests/zhiyu-workspace-ui.spec.ts \
  e2e/tests/zhiyu-settings-ui.spec.ts \
  e2e/tests/classroom-interaction.spec.ts
```

- [ ] **Step 2: Run full unit suite**

```bash
pnpm test
```

- [ ] **Step 3: Run lint/i18n/build**

```bash
pnpm lint
pnpm check:i18n-keys
pnpm build
```

- [ ] **Step 4: Manual check**

Verify:
- Workspace switching course/session still works
- Chat has exactly one active composer/lifecycle
- Settings modal keyboard focus and Escape work
- provider forms still save
- no P1 surface reintroduces academy branding or primary purple

- [ ] **Step 5: Commit verification fixes if required**

```bash
git add -A
git commit -m "fix(ui): resolve zhiyu p1 verification issues"
```
