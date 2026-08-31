# ZHIYU Brand + Home V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the academy-themed first-pass brand with ZHIYU and turn Home into a modular AI learning home while preserving the existing generation, folder, import, search, settings, and Pro-swap behavior.

**Architecture:** Keep `lib/brand/brand-config.ts` as the single brand source. Introduce only small presentation components for the lockup and Home feature-card layout; `app/page.tsx` continues to own existing state and handlers. Use stable `data-testid` selectors so the E2E suite stops depending on the old OpenMAIC image alt text.

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind CSS 4, existing Radix/shadcn/Lucide components, Playwright.

**Spec:** `zhiyu-implementation-plans/2026-08-31-zhiyu-full-ui-redesign-v2.md`

## Global Constraints

- Exact brand: `智域` / `ZHIYU`.
- Exact headline: `一句话，生成一堂互动课`.
- Exact supporting copy: `多智能体教师与同学，实时讲授与讨论`.
- Brand primary: `#356B59`; Home may use AI blue/lavender/yellow only as secondary semantic accents.
- No serif lockup, seal, literary/academy motifs, or fake learning metrics.
- Keep current generation/folder/import/search/settings/Pro handlers and state.
- Keep `lib/brand/brand-config.ts` as the only brand config.
- Do not rename the npm package or repository.
- Generated course thumbnails retain their own colors.

---

## File Structure

**Create**
- `components/brand/ZhiyuLockup.tsx` — reusable product lockup; presentation only.
- `components/home/ZhiyuLearningVisual.tsx` — original lightweight abstract learning/AI SVG; decorative only.
- `e2e/tests/zhiyu-home-ui.spec.ts` — stable product-structure assertions.

**Modify**
- `lib/brand/brand-config.ts` — ZHIYU names, assets, theme color.
- `app/layout.tsx` — metadata and sans-only brand setup.
- `app/globals.css` — ZHIYU global tokens and utility classes; remove academy-only display font use.
- `app/page.tsx` — Home information hierarchy and wrappers; reuse existing handlers.
- `lib/i18n/locales/zh-CN.json` — approved Home copy only.
- `lib/i18n/locales/en-US.json` — English fallbacks for new keys.
- `e2e/pages/home.page.ts` — stable ZHIYU selectors.
- `e2e/tests/home-to-generation.spec.ts` — keep behavior test, update brand expectation.
- `public/` — original ZHIYU mark/lockup assets if SVG files are preferred over inline mark.

**Do not modify**
- generation/orchestration/storage providers
- Home business hooks or the semantics of `handleGenerate`
- folder/course storage APIs
- Pro swap implementation

---

### Task 1: Lock the brand contract with a failing E2E test

**Files:**
- Create: `e2e/tests/zhiyu-home-ui.spec.ts`
- Modify: `e2e/pages/home.page.ts`

**Interfaces:**
- Consumes: current `/` route and existing Home textarea/generate controls.
- Produces: stable selectors `data-testid="zhiyu-brand-lockup"` and `data-testid="zhiyu-home-create-card"` that later tasks must render.

- [ ] **Step 1: Add stable locators to the Home page object**

Replace the old image-alt-based logo locator with:

```ts
export class HomePage {
  readonly page: Page;
  readonly logo: Locator;
  readonly createCard: Locator;
  readonly textarea: Locator;
  readonly enterButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.logo = page.getByTestId('zhiyu-brand-lockup');
    this.createCard = page.getByTestId('zhiyu-home-create-card');
    this.textarea = page.locator('textarea');
    this.enterButton = page
      .getByRole('button', { name: /start class|开课|进入课堂/i });
  }
}
```

- [ ] **Step 2: Write the failing Home structure test**

```ts
import { test, expect } from '../fixtures/base';
import { HomePage } from '../pages/home.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';

const SETTINGS_STORAGE = createSettingsStorage();

test.beforeEach(async ({ page }) => {
  await page.addInitScript((settings) => {
    localStorage.setItem('maic:account:settings-storage', settings);
    localStorage.setItem('locale', 'zh-CN');
  }, SETTINGS_STORAGE);
});

test('renders the ZHIYU learning home without academy branding', async ({ page }) => {
  const home = new HomePage(page);
  await home.goto();

  await expect(home.logo).toBeVisible();
  await expect(home.createCard).toBeVisible();
  await expect(page.getByText('一句话，生成一堂互动课')).toBeVisible();
  await expect(page.getByText('多智能体教师与同学，实时讲授与讨论')).toBeVisible();
  await expect(page.getByText('青衿')).toHaveCount(0);
  await expect(page.getByText('书院')).toHaveCount(0);
});
```

- [ ] **Step 3: Run the test and verify it fails**

Run:

```bash
pnpm exec playwright test e2e/tests/zhiyu-home-ui.spec.ts
```

Expected: FAIL because the ZHIYU test IDs and approved headline do not all exist yet.

- [ ] **Step 4: Commit the failing contract**

```bash
git add e2e/pages/home.page.ts e2e/tests/zhiyu-home-ui.spec.ts
git commit -m "test(home): define zhiyu home UI contract"
```

---

### Task 2: Replace the brand source and metadata

**Files:**
- Create: `components/brand/ZhiyuLockup.tsx`
- Modify: `lib/brand/brand-config.ts`
- Modify: `app/layout.tsx`
- Modify: `app/globals.css`

**Interfaces:**
- Consumes: existing `BrandConfig`, `useBrand()`, `DEFAULT_BRAND`.
- Produces: `ZhiyuLockup` with `size?: 'sm' | 'md' | 'lg'`, optional `showEnglish?: boolean`, and root `data-testid="zhiyu-brand-lockup"`.

- [ ] **Step 1: Add the ZHIYU brand values**

Update `DEFAULT_BRAND` to:

```ts
export const DEFAULT_BRAND: BrandConfig = {
  productName: '智域',
  shortName: '智域',
  logoSrc: '/zhiyu-lockup.svg',
  logoHasWordmark: true,
  markSrc: '/zhiyu-mark.svg',
  themeColor: '#356B59',
};
```

Keep the `BrandConfig` shape unchanged.

- [ ] **Step 2: Implement the reusable lockup**

Create:

```tsx
import { cn } from '@/lib/utils/cn';

export function ZhiyuLockup({
  size = 'md',
  showEnglish = true,
  className,
}: {
  readonly size?: 'sm' | 'md' | 'lg';
  readonly showEnglish?: boolean;
  readonly className?: string;
}) {
  const markSize = size === 'lg' ? 'size-9' : size === 'sm' ? 'size-6' : 'size-7';
  const textSize = size === 'lg' ? 'text-[24px]' : size === 'sm' ? 'text-[16px]' : 'text-[19px]';

  return (
    <div
      data-testid="zhiyu-brand-lockup"
      className={cn('inline-flex items-center gap-2.5', className)}
      aria-label="智域 ZHIYU"
    >
      <img src="/zhiyu-mark.svg" alt="" aria-hidden="true" className={markSize} />
      <div className="flex items-baseline gap-2">
        <span className={cn('font-semibold tracking-[-0.02em] text-foreground', textSize)}>
          智域
        </span>
        {showEnglish ? (
          <span className="text-[10px] font-semibold tracking-[0.16em] text-muted-foreground">
            ZHIYU
          </span>
        ) : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Update metadata**

Set:

```ts
export const metadata: Metadata = {
  title: '智域 · AI 互动课堂',
  description: '一句话，生成一堂互动课。多智能体教师与同学，实时讲授与讨论。',
};
```

Do not remove existing providers or font imports used by the rest of the product.

- [ ] **Step 4: Define ZHIYU global tokens**

Add/update CSS variables so the light theme exposes:

```css
:root {
  --background: #f3f2f0;
  --foreground: #142019;
  --card: #ffffff;
  --card-foreground: #142019;
  --primary: #356b59;
  --primary-foreground: #ffffff;
  --muted: #f4f6f4;
  --muted-foreground: #7e8983;
  --border: #dfe4e1;

  --zhiyu-ai: #5277b6;
  --zhiyu-ai-soft: #eaf0f9;
  --zhiyu-lavender: #7569b7;
  --zhiyu-lavender-soft: #efedf8;
  --zhiyu-learning: #c79528;
  --zhiyu-learning-soft: #f7efcf;
  --zhiyu-coral: #c75c63;
  --zhiyu-coral-soft: #f7e7e8;
}
```

Preserve existing shadcn variable names required elsewhere.

- [ ] **Step 5: Run type/build checks**

Run:

```bash
pnpm lint
pnpm build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add components/brand/ZhiyuLockup.tsx lib/brand/brand-config.ts app/layout.tsx app/globals.css public/
git commit -m "feat(brand): migrate product identity to zhiyu"
```

---

### Task 3: Update approved Home copy without rewriting locale files

**Files:**
- Modify: `lib/i18n/locales/zh-CN.json`
- Modify: `lib/i18n/locales/en-US.json`

**Interfaces:**
- Produces existing/new translation keys used by Home; no new i18n provider.

- [ ] **Step 1: Add/update only the required strings**

Ensure the Chinese values are:

```json
{
  "home.headline": "一句话，生成一堂互动课",
  "home.slogan": "多智能体教师与同学，实时讲授与讨论",
  "toolbar.enterClassroom": "开课"
}
```

If the locale files use nested objects rather than dotted literal keys, place the equivalent values in the existing object structure instead of duplicating keys.

- [ ] **Step 2: Add sensible English equivalents**

Use:

```json
{
  "home.headline": "Turn one idea into an interactive class",
  "home.slogan": "Learn with AI teachers and classmates in real-time lessons and discussion",
  "toolbar.enterClassroom": "Start class"
}
```

- [ ] **Step 3: Verify i18n consistency**

Run:

```bash
pnpm check:i18n-keys
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/i18n/locales/zh-CN.json lib/i18n/locales/en-US.json
git commit -m "feat(i18n): add zhiyu learning-home copy"
```

---

### Task 4: Build the original learning visual

**Files:**
- Create: `components/home/ZhiyuLearningVisual.tsx`
- Test: `e2e/tests/zhiyu-home-ui.spec.ts`

**Interfaces:**
- Produces `ZhiyuLearningVisual({ className?: string })`; decorative SVG only; no click handlers or data dependencies.

- [ ] **Step 1: Extend the failing E2E test**

Add:

```ts
await expect(page.getByTestId('zhiyu-learning-visual')).toBeVisible();
```

- [ ] **Step 2: Verify failure**

Run:

```bash
pnpm exec playwright test e2e/tests/zhiyu-home-ui.spec.ts
```

Expected: FAIL on missing `zhiyu-learning-visual`.

- [ ] **Step 3: Implement a lightweight original SVG**

Create a component whose root is:

```tsx
export function ZhiyuLearningVisual({ className }: { readonly className?: string }) {
  return (
    <svg
      data-testid="zhiyu-learning-visual"
      className={className}
      viewBox="0 0 360 240"
      role="img"
      aria-label="AI learning network illustration"
    >
      {/* Original abstract nodes, lesson cards and connection lines only.
          Use CSS variables/currentColor; do not copy Dribbble artwork. */}
    </svg>
  );
}
```

Use ZHIYU green as the dominant accent and blue/lavender/yellow only in small subordinate shapes. Keep it static for P0.

- [ ] **Step 4: Verify test passes after it is mounted in Task 5**

Do not add a separate hidden mount just to pass this test.

- [ ] **Step 5: Commit**

```bash
git add components/home/ZhiyuLearningVisual.tsx e2e/tests/zhiyu-home-ui.spec.ts
git commit -m "feat(home): add original zhiyu learning visual"
```

---

### Task 5: Recompose Home into a modular AI learning home

**Files:**
- Modify: `app/page.tsx`
- Test: `e2e/tests/zhiyu-home-ui.spec.ts`
- Test: `e2e/tests/home-to-generation.spec.ts`

**Interfaces:**
- Consumes all existing Home state, `GreetingBar`, `AgentBar`, `GenerationToolbar`, `InteractiveModeButton`, `SpeechButton`, folder/course handlers, search/import/settings handlers, Pro swap hooks.
- Produces only presentation wrappers; existing handler signatures remain unchanged.

- [ ] **Step 1: Add the failing creation-card assertion**

Ensure the E2E test checks:

```ts
await expect(page.getByTestId('zhiyu-home-create-card')).toBeVisible();
await expect(page.getByRole('button', { name: '开课' })).toBeDisabled();
```

- [ ] **Step 2: Recompose only the JSX hierarchy around existing controls**

The top-level Home presentation should follow:

```tsx
<header>{/* ZhiyuLockup + existing language/theme/settings */}</header>

<main>
  <section>{/* greeting + headline */}</section>

  <section className="grid ...">
    <div data-testid="zhiyu-home-create-card">
      {/* Existing GreetingBar/AgentBar/textarea/toolbars/buttons, same handlers */}
    </div>
    <div>
      <ZhiyuLearningVisual />
      {/* one short real product statement; no fake metrics */}
    </div>
  </section>

  <section>
    {/* Existing recent courses/folders/search/import actions, same data/handlers */}
  </section>
</main>
```

Do not duplicate `handleGenerate`; pass the original function to the existing button.

- [ ] **Step 3: Replace academy visual remnants**

Remove Home-only use of:
- serif brand class
- bronze seal
- academy wording
- obsolete OpenMAIC hero image
- decorative purple/blue glow orbs

Do not delete old public assets if other routes still reference them.

- [ ] **Step 4: Keep real course-card data only**

The recent-course cards may show only values already present in the stage/folder objects, such as:
- title
- thumbnail
- scene/page count if already available
- created/updated time if already available
- generation state if already available

Do not synthesize progress percentages.

- [ ] **Step 5: Run Home tests**

Run:

```bash
pnpm exec playwright test e2e/tests/zhiyu-home-ui.spec.ts e2e/tests/home-to-generation.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/page.tsx e2e/tests/zhiyu-home-ui.spec.ts e2e/tests/home-to-generation.spec.ts
git commit -m "feat(home): redesign zhiyu learning home"
```

---

### Task 6: P0 Home verification gate

**Files:**
- No feature files unless a regression is found.

**Interfaces:**
- Produces a shippable Home checkpoint.

- [ ] **Step 1: Run static checks**

```bash
pnpm lint
pnpm check:i18n-keys
```

Expected: PASS.

- [ ] **Step 2: Run targeted E2E**

```bash
pnpm exec playwright test e2e/tests/zhiyu-home-ui.spec.ts e2e/tests/home-to-generation.spec.ts
```

Expected: PASS.

- [ ] **Step 3: Run production build**

```bash
pnpm build
```

Expected: PASS.

- [ ] **Step 4: Manual 1440px check**

Verify:
- ZHIYU lockup is visible and not serif/academy-themed.
- Composer is still the primary action.
- Illustration does not overpower the composer.
- Recent courses use real data only.
- Settings opens without body-spacing regression.
- Chinese and English locales do not overflow the header.

- [ ] **Step 5: Commit only if verification required fixes**

```bash
git add -A
git commit -m "fix(home): resolve zhiyu home verification issues"
```
