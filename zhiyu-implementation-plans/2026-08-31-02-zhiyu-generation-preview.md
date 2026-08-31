# ZHIYU Generation Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `/generation-preview` from a generic generation screen into a truthful AI course-construction dashboard while preserving outline review, retries, generation state, and classroom navigation.

**Architecture:** Keep `app/generation-preview/page.tsx` as the owner of generation state and callbacks. Extract presentation-only projection and view components so the 63K page file does not accumulate more visual branching. The timeline must derive from existing real state; no timer-based fake steps or invented percentages.

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind CSS 4, existing generation hooks/stores, Vitest, Playwright.

**Spec:** `zhiyu-implementation-plans/2026-08-31-zhiyu-full-ui-redesign-v2.md`

## Global Constraints

- Do not change generation APIs, retry semantics, outline-review behavior, sessionStorage handoff, or classroom redirect behavior.
- Timeline status is a pure projection of existing generation state.
- Do not create fake progress percentages.
- Use ZHIYU green for complete, AI blue for active, neutral for pending, and danger/coral for errors.
- The current Scene preview keeps generated slide colors.
- Illustration is original and decorative.
- Existing outline-review accessibility names must remain valid.

---

## File Structure

**Create**
- `app/generation-preview/components/ZhiyuGenerationShell.tsx` — two-column generation dashboard layout.
- `app/generation-preview/components/ZhiyuGenerationTimeline.tsx` — presentational timeline.
- `app/generation-preview/components/zhiyu-generation-state.ts` — pure state projection.
- `tests/generation-preview/zhiyu-generation-state.test.ts` — deterministic projection tests.
- `e2e/tests/zhiyu-generation-ui.spec.ts` — structural E2E assertions.

**Modify**
- `app/generation-preview/page.tsx` — wire existing state into new shell.
- `app/generation-preview/layout.tsx` — only if route shell needs background/height.
- `app/generation-preview/components/visualizers.tsx` — skin only where current preview chrome conflicts.
- `e2e/pages/generation-preview.page.ts` — add stable ZHIYU locators without removing outline-review locators.
- `e2e/tests/generation-flow.spec.ts` — ensure flow still works.

---

### Task 1: Define a pure timeline projection

**Files:**
- Create: `app/generation-preview/components/zhiyu-generation-state.ts`
- Create: `tests/generation-preview/zhiyu-generation-state.test.ts`

**Interfaces:**
- Produces:

```ts
export type ZhiyuGenerationStatus = 'done' | 'active' | 'pending' | 'error';

export type ZhiyuGenerationStep = {
  id: 'goal' | 'outline' | 'agents' | 'scenes' | 'media';
  labelKey: string;
  status: ZhiyuGenerationStatus;
  detail?: string;
};

export function projectZhiyuGenerationSteps(input: {
  outlineReady: boolean;
  agentsReady: boolean;
  generatedSceneCount: number;
  totalSceneCount: number;
  mediaPending: boolean;
  errorStage?: 'outline' | 'agents' | 'scenes' | 'media' | null;
}): readonly ZhiyuGenerationStep[];
```

- [ ] **Step 1: Write the failing unit test**

```ts
import { describe, expect, it } from 'vitest';
import { projectZhiyuGenerationSteps } from '@/app/generation-preview/components/zhiyu-generation-state';

describe('projectZhiyuGenerationSteps', () => {
  it('marks scene generation active after outline and agents are ready', () => {
    const steps = projectZhiyuGenerationSteps({
      outlineReady: true,
      agentsReady: true,
      generatedSceneCount: 3,
      totalSceneCount: 10,
      mediaPending: true,
      errorStage: null,
    });

    expect(steps.map((step) => [step.id, step.status])).toEqual([
      ['goal', 'done'],
      ['outline', 'done'],
      ['agents', 'done'],
      ['scenes', 'active'],
      ['media', 'pending'],
    ]);
    expect(steps.find((step) => step.id === 'scenes')?.detail).toBe('3 / 10');
  });

  it('projects the real error stage without completing later steps', () => {
    const steps = projectZhiyuGenerationSteps({
      outlineReady: true,
      agentsReady: true,
      generatedSceneCount: 4,
      totalSceneCount: 10,
      mediaPending: true,
      errorStage: 'scenes',
    });

    expect(steps.find((step) => step.id === 'scenes')?.status).toBe('error');
    expect(steps.find((step) => step.id === 'media')?.status).toBe('pending');
  });
});
```

- [ ] **Step 2: Run and verify failure**

```bash
pnpm exec vitest run tests/generation-preview/zhiyu-generation-state.test.ts
```

Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement the pure projection**

Implement only deterministic status derivation. Do not read stores inside this file.

- [ ] **Step 4: Run and verify pass**

```bash
pnpm exec vitest run tests/generation-preview/zhiyu-generation-state.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/generation-preview/components/zhiyu-generation-state.ts tests/generation-preview/zhiyu-generation-state.test.ts
git commit -m "feat(generation): project zhiyu generation timeline state"
```

---

### Task 2: Add the generation shell and timeline components

**Files:**
- Create: `app/generation-preview/components/ZhiyuGenerationShell.tsx`
- Create: `app/generation-preview/components/ZhiyuGenerationTimeline.tsx`
- Create: `e2e/tests/zhiyu-generation-ui.spec.ts`

**Interfaces:**
- `ZhiyuGenerationTimeline({ steps })`
- `ZhiyuGenerationShell({ title, steps, preview, illustration, actions })`
- root test IDs:
  - `zhiyu-generation-shell`
  - `zhiyu-generation-timeline`
  - `zhiyu-generation-preview`

- [ ] **Step 1: Write the failing E2E structural test**

```ts
import { test, expect } from '../fixtures/base';
import { GenerationPreviewPage } from '../pages/generation-preview.page';

test('uses the ZHIYU course-construction shell', async ({ page }) => {
  const generation = new GenerationPreviewPage(page);
  await generation.goto();

  await expect(page.getByTestId('zhiyu-generation-shell')).toBeVisible();
  await expect(page.getByTestId('zhiyu-generation-timeline')).toBeVisible();
  await expect(page.getByTestId('zhiyu-generation-preview')).toBeVisible();
});
```

Use the same fixture/bootstrap assumptions already used by generation E2E; if the current route redirects without seeded state, place these assertions into the existing seeded generation-flow fixture rather than introducing mock production code.

- [ ] **Step 2: Run and verify failure**

```bash
pnpm exec playwright test e2e/tests/zhiyu-generation-ui.spec.ts
```

Expected: FAIL on missing shell IDs.

- [ ] **Step 3: Implement timeline presentation**

Render each projected step with:
- icon/status marker
- translated label
- optional detail
- semantic `data-status`

Do not mutate generation state from the timeline component.

- [ ] **Step 4: Implement two-column shell**

Desktop:
- left construction/status panel
- right generated Scene preview
- top route/header area
- existing action controls passed through as `actions`

Responsive:
- below desktop breakpoint, stack left above preview

- [ ] **Step 5: Commit**

```bash
git add app/generation-preview/components/ZhiyuGenerationShell.tsx app/generation-preview/components/ZhiyuGenerationTimeline.tsx e2e/tests/zhiyu-generation-ui.spec.ts
git commit -m "feat(generation): add zhiyu course construction shell"
```

---

### Task 3: Wire real generation state into the shell

**Files:**
- Modify: `app/generation-preview/page.tsx`
- Modify: `e2e/pages/generation-preview.page.ts`

**Interfaces:**
- Consumes existing generation state already computed in `page.tsx`.
- Produces projected props only; no new store.

- [ ] **Step 1: Add stable page-object locators**

Add:

```ts
readonly shell: Locator;
readonly timeline: Locator;
readonly preview: Locator;

this.shell = page.getByTestId('zhiyu-generation-shell');
this.timeline = page.getByTestId('zhiyu-generation-timeline');
this.preview = page.getByTestId('zhiyu-generation-preview');
```

Keep existing outline-review locators unchanged.

- [ ] **Step 2: Derive projection inputs from existing real values**

Inside `page.tsx`, map the actual current state to:

```ts
const zhiyuSteps = projectZhiyuGenerationSteps({
  outlineReady: /* existing outline-ready fact */,
  agentsReady: /* existing agent-ready fact */,
  generatedSceneCount: /* existing generated scene count */,
  totalSceneCount: /* existing outline/scene total */,
  mediaPending: /* existing media-pending fact */,
  errorStage: /* map existing error state, or null */,
});
```

Do not introduce timers or arbitrary `setTimeout` progress.

- [ ] **Step 3: Replace only the page-level presentation hierarchy**

Wrap existing preview/review/error controls in `ZhiyuGenerationShell`.

Preserve:
- back/cancel
- outline expand/review
- “always review” setting
- confirm-and-generate
- retry behavior
- redirect to classroom
- sessionStorage generation parameters

- [ ] **Step 4: Keep review mode accessible**

Run:

```bash
pnpm exec playwright test e2e/tests/generation-flow.spec.ts
```

Expected: existing outline-review flow remains PASS.

- [ ] **Step 5: Commit**

```bash
git add app/generation-preview/page.tsx e2e/pages/generation-preview.page.ts
git commit -m "feat(generation): wire live generation state into zhiyu shell"
```

---

### Task 4: Restyle preview chrome without touching generated content

**Files:**
- Modify: `app/generation-preview/components/visualizers.tsx`
- Modify: `app/generation-preview/layout.tsx` only if needed.

**Interfaces:**
- Generated scene renderer remains unchanged.
- Only outer container/background/status chrome may change.

- [ ] **Step 1: Add an E2E assertion that the preview surface exists independently**

```ts
await expect(page.getByTestId('zhiyu-generation-preview')).toBeVisible();
```

Do not assert internal slide colors.

- [ ] **Step 2: Apply ZHIYU preview shell styles**

Use neutral canvas and light card treatment. Do not set inherited `color`, `background`, or CSS filters on the generated Scene root that could alter course content.

- [ ] **Step 3: Verify generated preview still renders**

Run targeted generation E2E:

```bash
pnpm exec playwright test e2e/tests/generation-flow.spec.ts e2e/tests/zhiyu-generation-ui.spec.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/generation-preview/components/visualizers.tsx app/generation-preview/layout.tsx e2e/tests/zhiyu-generation-ui.spec.ts
git commit -m "style(generation): apply zhiyu preview chrome"
```

---

### Task 5: Generation P0 verification gate

- [ ] **Step 1: Run unit tests**

```bash
pnpm exec vitest run tests/generation-preview/zhiyu-generation-state.test.ts tests/generation-preview/vocational-mode.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run generation E2E**

```bash
pnpm exec playwright test e2e/tests/home-to-generation.spec.ts e2e/tests/generation-flow.spec.ts e2e/tests/zhiyu-generation-ui.spec.ts
```

Expected: PASS.

- [ ] **Step 3: Run i18n + lint**

```bash
pnpm check:i18n-keys
pnpm lint
```

Expected: PASS.

- [ ] **Step 4: Run production build**

```bash
pnpm build
```

Expected: PASS.

- [ ] **Step 5: Manual check**

Verify:
- status colors have meaning
- no fake percentage
- outline review still works
- active Scene preview retains its generated visual style
- stacked responsive layout is usable
- final transition to classroom still occurs exactly as before

- [ ] **Step 6: Commit only verification fixes**

```bash
git add -A
git commit -m "fix(generation): resolve zhiyu generation verification issues"
```
