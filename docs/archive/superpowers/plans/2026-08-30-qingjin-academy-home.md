# 青衿书院 Round 1 Homepage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle `/` and Workspace home into the 青衿书院 visual system without changing generate / library / settings / Pro-swap handlers.

**Architecture:** Keep existing React trees and data flow. Change identity (`DEFAULT_BRAND` + two required SVGs), global tokens (`--primary` → celadon), homepage chrome (real top bar, typeset lockup, footer attribution), and homepage-visible violet/cyan class names. Workspace inherits the same tokens via `--ws-accent`. Smoke-test out-of-round shadcn surfaces; do not redesign them.

**Tech Stack:** Next.js 16, React 19, Tailwind v4, existing `@fontsource/noto-serif-sc`, Vitest, pnpm scripts from README-zh.md.

**Spec:** `docs/superpowers/specs/2026-08-30-qingjin-academy-home-design.md`

## Global Constraints

- Do not change generation, orchestration, playback, providers, or storage logic.
- Do not add npm/pnpm dependencies. Reuse existing `@fontsource/noto-serif-sc`.
- Brand is locked: `productName/shortName = 青衿`, `logoSrc = /qingjin-lockup.svg`, `markSrc = /qingjin-mark.svg`, `logoHasWordmark = true`, `themeColor = #3D6B5A`.
- Top bar shows 青衿 + seal only. OpenMAIC appears only as footer attribution.
- Global `--primary` change is intentional and may recolor Classroom / Chat / Settings; smoke-test only.
- Working directory is always `D:\ZZGG_Innovation_Project\OpenMAIC-main`. Use the repo’s existing `pnpm` + `node_modules`. Do not `npm i -g`, do not `npx` new CLIs, do not change the user-level pnpm store, do not write extra caches onto the C: drive.
- Do not commit unless the user explicitly asks. If they do, use the commit messages in each task.
- Desktop 1280–1512 first. Respect `prefers-reduced-motion`.

### File map

| File | Responsibility |
|---|---|
| `public/qingjin-mark.svg` | Square bronze seal |
| `public/qingjin-lockup.svg` | Horizontal wordmark+seal for `logoSrc` consumers |
| `lib/brand/brand-config.ts` | Identity source of truth |
| `tests/lib/brand/brand-config.test.ts` | Identity contract |
| `app/globals.css` | Paper/Ink/Celadon tokens + `--font-display` |
| `app/layout.tsx` | Metadata + Noto Serif SC import |
| `lib/i18n/locales/*.json` | headline / slogan / footer / 开课 |
| `app/page.tsx` | Top bar, hero, composer skin, cards, footer (classes/markup only) |
| `components/generation/generation-toolbar.tsx` | Homepage-visible accent classes |
| `components/generation/interactive-mode-button.tsx` | Cyan → celadon |
| `components/discovery/folder-card.tsx` | Violet → celadon |
| `components/discovery/folder-dialogs.tsx` | Focus ring |
| `components/discovery/move-to-folder-menu.tsx` | Check / focus |
| `components/workbench/workspace-shell.css` | Canvas + `--ws-accent` |
| `components/workbench/workspace/WorkspaceHome.tsx` | Desktop typeset lockup; mobile `logoSrc` img |
| `components/workbench/ProBadge.tsx` | Violet → celadon |

Keep `/logo-horizontal.png` and `/openmaic-mark.png` on disk.

---

### Task 1: Brand identity contract

**Files:**
- Create: `public/qingjin-mark.svg`
- Create: `public/qingjin-lockup.svg`
- Modify: `lib/brand/brand-config.ts`
- Test: `tests/lib/brand/brand-config.test.ts`

**Interfaces:**
- Consumes: existing `BrandConfig`
- Produces: `DEFAULT_BRAND` with the locked fields in the spec §2

- [ ] **Step 1: Write the failing brand test**

Replace `tests/lib/brand/brand-config.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_BRAND } from '@/lib/brand/brand-config';

describe('DEFAULT_BRAND (single-brand build)', () => {
  it('uses the Qingjin product identity for full chrome', () => {
    expect(DEFAULT_BRAND.productName).toBe('青衿');
    expect(DEFAULT_BRAND.shortName).toBe('青衿');
    expect(DEFAULT_BRAND.markSrc).toBe('/qingjin-mark.svg');
    expect(DEFAULT_BRAND.themeColor).toBe('#3D6B5A');
  });

  it('marks its horizontal logo as already containing the wordmark', () => {
    expect(DEFAULT_BRAND.logoHasWordmark).toBe(true);
    expect(DEFAULT_BRAND.logoSrc).toBe('/qingjin-lockup.svg');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run (cwd = repo root, existing pnpm only):

```bash
pnpm exec vitest run tests/lib/brand/brand-config.test.ts
```

Expected: FAIL — `expected 'OpenMAIC' to be '青衿'` and old asset paths.

- [ ] **Step 3: Add the two required SVGs**

`public/qingjin-mark.svg` (32×32 bronze seal, character 衿):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none">
  <rect width="32" height="32" rx="3" fill="#8A6A3D"/>
  <rect x="2.5" y="2.5" width="27" height="27" rx="1.5" stroke="#F4F6F3" stroke-width="1.25"/>
  <text x="16" y="22.5" text-anchor="middle" fill="#F4F6F3"
    font-family="Noto Serif SC, Source Han Serif SC, serif" font-size="16" font-weight="700">衿</text>
</svg>
```

`public/qingjin-lockup.svg` (horizontal wordmark + seal; used as `logoSrc` fallback):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 36" fill="none">
  <rect x="0" y="2" width="32" height="32" rx="3" fill="#8A6A3D"/>
  <rect x="2.5" y="4.5" width="27" height="27" rx="1.5" stroke="#F4F6F3" stroke-width="1.25"/>
  <text x="16" y="24.5" text-anchor="middle" fill="#F4F6F3"
    font-family="Noto Serif SC, Source Han Serif SC, serif" font-size="16" font-weight="700">衿</text>
  <text x="44" y="26" fill="#1B2420"
    font-family="Noto Serif SC, Source Han Serif SC, serif" font-size="22" font-weight="700">青衿</text>
</svg>
```

Do not delete `public/logo-horizontal.png` or `public/openmaic-mark.png`.

- [ ] **Step 4: Update `DEFAULT_BRAND`**

In `lib/brand/brand-config.ts` replace the export with:

```ts
export const DEFAULT_BRAND: BrandConfig = {
  productName: '青衿',
  shortName: '青衿',
  logoSrc: '/qingjin-lockup.svg',
  logoHasWordmark: true,
  markSrc: '/qingjin-mark.svg',
  themeColor: '#3D6B5A',
};
```

- [ ] **Step 5: Re-run the brand test**

```bash
pnpm exec vitest run tests/lib/brand/brand-config.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 6: Commit (only if the user asked)**

```bash
git add public/qingjin-mark.svg public/qingjin-lockup.svg lib/brand/brand-config.ts tests/lib/brand/brand-config.test.ts
git commit -m "feat(brand): lock Qingjin identity and SVG assets"
```

---

### Task 2: Tokens and display font

**Files:**
- Modify: `app/globals.css`
- Modify: `app/layout.tsx`

**Interfaces:**
- Consumes: `@fontsource/noto-serif-sc` already in `package.json` (`^5.2.8`); 400/700 already used by `app/editor-fonts.ts`
- Produces: `--primary #3D6B5A`, Paper/Ink canvas, `--font-display`, metadata title `青衿`

- [ ] **Step 1: Point `--font-display` and recolor `:root` / `.dark`**

In `app/globals.css` `@theme inline`, add:

```css
--font-display: var(--font-display);
```

In `:root` replace the identity-related tokens (leave `--radius` at `0.625rem`):

```css
--font-sans: 'Inter Variable', ui-sans-serif, system-ui, sans-serif;
--font-display: 'Noto Serif SC', ui-serif, 'Source Han Serif SC', serif;
--background: #f4f6f3;
--foreground: #1b2420;
--card: #fbfcfb;
--card-foreground: #1b2420;
--popover: #fbfcfb;
--popover-foreground: #1b2420;
--primary: #3d6b5a;
--primary-foreground: #fbfcfb;
--secondary: #e8eeea;
--secondary-foreground: #1b2420;
--muted: #e8eeea;
--muted-foreground: #5c6b64;
--accent: #e8eeea;
--accent-foreground: #1b2420;
--border: #1b242014;
--input: #1b242014;
--ring: #3d6b5a;
```

In `.dark` set:

```css
--background: #121816;
--foreground: #e8eeea;
--card: #1a221f;
--card-foreground: #e8eeea;
--popover: #1a221f;
--popover-foreground: #e8eeea;
--primary: #7fa392;
--primary-foreground: #121816;
--secondary: #1a221f;
--secondary-foreground: #e8eeea;
--muted: #1a221f;
--muted-foreground: #9aa89f;
--accent: #1a221f;
--accent-foreground: #e8eeea;
--border: #e8eeea14;
--input: #e8eeea14;
--ring: #7fa392;
```

Do not add a second homepage-only primary token.

- [ ] **Step 2: Import the existing serif in the root layout and update metadata**

In `app/layout.tsx` add these imports next to the Inter import (same package, no install):

```ts
import '@fontsource/noto-serif-sc/400.css';
import '@fontsource/noto-serif-sc/700.css';
```

Replace metadata:

```ts
export const metadata: Metadata = {
  title: '青衿',
  description: '一句话，生成一堂多智能体互动课。',
};
```

- [ ] **Step 3: Confirm no new dependency was added**

```bash
git diff -- package.json package-lock.json pnpm-lock.yaml
```

Expected: no dependency changes.

- [ ] **Step 4: Commit (only if the user asked)**

```bash
git add app/globals.css app/layout.tsx
git commit -m "feat(theme): switch global tokens to Qingjin celadon"
```

---

### Task 3: i18n keys

**Files:**
- Modify: all 12 files in `lib/i18n/locales/`

**Interfaces:**
- Consumes: existing `home.*` and `toolbar.enterClassroom`
- Produces: `home.headline`, `home.footer` in every locale; zh-CN hero/CTA copy from spec §7

`pnpm check:i18n-keys` diffs every locale against `en-US.json`. New keys must exist in all 12 files.

- [ ] **Step 1: Add keys to `en-US.json`**

Under `home`:

```json
"headline": "One prompt. A whole classroom.",
"slogan": "Teachers and classmates, lecturing and discussing in real time",
"footer": "Qingjin · An AI teaching workspace based on OpenMAIC",
"greetingWithName": "Hi, {{name}}"
```

Under `toolbar`, set `"enterClassroom": "Start class"`.

- [ ] **Step 2: Add the same keys to the other 11 locales**

`zh-CN.json`:

```json
"headline": "一句话，生成一堂课",
"slogan": "多智能体教师与同学，实时讲授与讨论",
"footer": "青衿 · 基于 OpenMAIC 的 AI 教学工作台",
"enterClassroom": "开课"
```

`zh-TW.json`:

```json
"headline": "一句話，生成一堂課",
"slogan": "多智能體教師與同學，即時講授與討論",
"footer": "青衿 · 基於 OpenMAIC 的 AI 教學工作臺",
"enterClassroom": "開課"
```

For `ja-JP`, `ko-KR`, `vi-VN`, `fr-FR`, `es-MX`, `de-DE`, `pt-BR`, `ru-RU`, `ar-SA`: copy the **en-US** `headline` / `footer` / `enterClassroom` strings (English-meaning fallback). Keep each file’s existing `greetingWithName`. Update `slogan` only if you are already touching that object; otherwise leave the current slogan and still add `headline` + `footer`.

- [ ] **Step 3: Run the i18n checker**

```bash
pnpm check:i18n-keys
```

Expected: exit 0, no missing/extra keys.

- [ ] **Step 4: Commit (only if the user asked)**

```bash
git add lib/i18n/locales
git commit -m "feat(i18n): add Qingjin headline, footer, and Start-class CTA"
```

---

### Task 4: Classic homepage chrome

**Files:**
- Modify: `app/page.tsx` — markup and classNames only. Do not edit `handleGenerate`, form state, folder/search/import handlers, or `data-pro-morph` attribute names.

**Interfaces:**
- Consumes: `t('home.headline')`, `t('home.slogan')`, `t('home.footer')`, `t('toolbar.enterClassroom')`
- Produces: real top bar; typeset 青衿 + seal; porcelain composer; footer attribution

- [ ] **Step 1: Replace the page canvas and delete the purple orbs**

Change the root wrapper class from the slate/violet gradient to:

```tsx
<div className="relative min-h-[100dvh] w-full bg-background text-foreground flex flex-col items-center p-4 pt-20 md:p-8 md:pt-20 overflow-x-hidden">
```

Delete the entire `{/* ═══ Background Decor ═══ */}` block (the two `blur-3xl animate-pulse` orbs).

- [ ] **Step 2: Replace the floating pill with a product top bar**

Replace the `fixed top-4 right-4 ... rounded-full` toolbar with a full-width bar. Keep the same `toolbarRef`, `LanguageSwitcher`, theme menu, settings button, and `setSettingsOpen(true)` handler:

```tsx
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
    {/* existing LanguageSwitcher, theme menu, Settings button — drop the candy-pill chrome */}
  </div>
</div>
```

Theme-menu selected rows: replace `bg-purple-50 ... text-purple-600` with `bg-primary/10 text-primary`.

- [ ] **Step 3: Replace the logo image hero with typeset headline**

Remove the `<motion.img src="/logo-horizontal.png" ...>` block (file stays on disk). Keep `data-pro-morph="lockup"` on the top-bar lockup from Step 2 so Pro swap still has an anchor — if the swap expects the lockup inside the hero, **also** keep a visually hidden or compact typeset lockup in the hero with the same `data-pro-morph="lockup"` rather than inventing a new morph name.

Hero copy:

```tsx
<h1
  className="text-[28px] md:text-[36px] font-semibold tracking-tight text-foreground text-center"
  style={{ fontFamily: 'var(--font-display)' }}
>
  {t('home.headline')}
</h1>
<p className="mt-2 text-sm text-muted-foreground mb-8 text-center">{t('home.slogan')}</p>
```

- [ ] **Step 4: Skin the composer without touching its bindings**

On the composer wrapper, replace violet focus with celadon:

```tsx
className="w-full rounded-2xl border border-border bg-card/90 backdrop-blur-xl shadow-[0_1px_0_rgba(27,36,32,0.04),0_12px_32px_rgba(27,36,32,0.04)] transition-shadow focus-within:shadow-[0_0_0_1px_var(--primary),0_0_0_6px_color-mix(in_srgb,var(--primary)_6%,transparent)]"
```

Keep `data-pro-morph="composer"`. Keep `textarea` value/onChange/onKeyDown. Keep `GenerationToolbar` props. Keep the generate `onClick={handleGenerate}` and `disabled={!canGenerate || preparingGenerate}`.

Generate button label already uses `t('toolbar.enterClassroom')` — after Task 3 it reads 开课. Selected/hover rings on `GreetingBar` (`ring-violet-*`, `text-violet-500`, `hover:bg-violet-100`) → `ring-primary/*`, `text-primary`, `hover:bg-primary/10`.

Vocational chip: `cyan-*` → `primary` / bronze border. Do not remove the flag gate.

- [ ] **Step 5: Skin course cards and footer**

In `ClassroomCard` (same file):

- empty thumbnail wash: `from-violet-100 to-blue-100` → `from-primary/10 to-primary/5`
- meta pill: `bg-violet-100 ... text-violet-600` → `bg-primary/10 text-primary`
- search folder badge: `bg-violet-500/80` → `bg-primary/80`
- rename underline: `border-violet-400/60` → `border-primary/60`

Footer:

```tsx
<div className="mt-auto pt-12 pb-4 text-center text-xs text-muted-foreground/50">
  {t('home.footer')}
</div>
```

- [ ] **Step 6: Grep the homepage file for leftover violet**

```bash
rg "violet|purple|#722ed1" app/page.tsx
```

Expected: no matches.

- [ ] **Step 7: Commit (only if the user asked)**

```bash
git add app/page.tsx
git commit -m "feat(home): Qingjin academy chrome for classic landing"
```

---

### Task 5: Homepage-visible accent classes

**Files:**
- Modify: `components/generation/generation-toolbar.tsx` (class strings only)
- Modify: `components/generation/interactive-mode-button.tsx` (class strings only)
- Modify: `components/discovery/folder-card.tsx`
- Modify: `components/discovery/folder-dialogs.tsx`
- Modify: `components/discovery/move-to-folder-menu.tsx`

**Interfaces:**
- Consumes: unchanged props
- Produces: same components, celadon/primary classes

Do **not** restyle `components/generation/outlines-editor.tsx` or `media-popover.tsx` (generation-preview, out of round).

- [ ] **Step 1: Map violet/cyan utilities to `primary`**

Mechanical replacements on the five files above:

| From | To |
|---|---|
| `violet-50` / `bg-violet-100` / `dark:bg-violet-900/30` | `bg-primary/10` / `dark:bg-primary/15` |
| `text-violet-600` / `text-violet-700` / `text-violet-500` / `text-violet-400` | `text-primary` |
| `border-violet-*` | `border-primary/40` (or `/70` where the old class was stronger) |
| `ring-violet-*` | `ring-primary` |
| `from-violet-50 to-blue-50` | `from-primary/10 to-primary/5` |
| `bg-violet-500` / `bg-violet-500/20` | `bg-primary` / `bg-primary/20` |
| interactive `cyan-*` | the matching `primary` / `primary-foreground` pair |
| `outline-cyan-700` | `outline-primary` |

Do not change function signatures, event handlers, or Select logic in `generation-toolbar.tsx`.

- [ ] **Step 2: Confirm those files no longer mention violet/purple/cyan brand chrome**

```bash
rg "violet|purple|cyan-|#722ed1" components/generation/generation-toolbar.tsx components/generation/interactive-mode-button.tsx components/discovery/folder-card.tsx components/discovery/folder-dialogs.tsx components/discovery/move-to-folder-menu.tsx
```

Expected: no brand-color matches. (If `cyan` remains in a comment, delete the comment.)

- [ ] **Step 3: Commit (only if the user asked)**

```bash
git add components/generation/generation-toolbar.tsx components/generation/interactive-mode-button.tsx components/discovery/folder-card.tsx components/discovery/folder-dialogs.tsx components/discovery/move-to-folder-menu.tsx
git commit -m "style(home): recolor homepage controls from violet to celadon"
```

---

### Task 6: Workspace home + Pro badge

**Files:**
- Modify: `components/workbench/workspace-shell.css` — tokens only
- Modify: `components/workbench/workspace/WorkspaceHome.tsx` — lockup presentation only
- Modify: `components/workbench/ProBadge.tsx` — classNames only

**Interfaces:**
- Consumes: `brand.logoSrc`, `brand.logoHasWordmark`, `data-pro-morph`
- Produces: same Pro swap hooks; desktop typeset lockup; `<md` image at `/qingjin-lockup.svg`

- [ ] **Step 1: Recolor workspace tokens**

In `.ws-root` set:

```css
--ws-canvas-top: #f4f6f3;
--ws-canvas-bottom: #e8eeea;
--ws-accent: #3d6b5a;
--ws-accent-thread: rgba(61, 107, 90, 0.32);
--ws-accent-wash: rgba(61, 107, 90, 0.08);
```

Change the last cast in `--ws-lift-focus` from `rgba(124, 58, 237, 0.14)` to `rgba(61, 107, 90, 0.14)`.

In `.dark .ws-root` set:

```css
--ws-canvas-top: #121816;
--ws-canvas-bottom: #0e1412;
--ws-accent: #7fa392;
--ws-accent-thread: rgba(127, 163, 146, 0.36);
--ws-accent-wash: rgba(127, 163, 146, 0.1);
```

Do not change rail tree layout variables (`--ws-tree-*`, `--ws-pane-head-h`, etc.).

- [ ] **Step 2: Split mobile image vs desktop typeset lockup**

In `WorkspaceHome.tsx` compact header (`md:hidden`), keep:

```tsx
<img src={brand.logoSrc} alt={brand.productName} className="h-5 w-auto" />
```

That image **must** resolve to `/qingjin-lockup.svg`.

On the desktop hero lockup (`data-pro-morph="lockup"`), do **not** render the SVG as the main mark. Render typeset 青衿 + bronze seal (same markup as the classic top bar). Keep `ProBadge` in the `data-pro-morph="badge"` slot. Do not change `onExitPro`, `ProLaunchPanel` props, or `data-testid` values.

If `brand.logoHasWordmark` is true, the current code takes the `<img src={brand.logoSrc}>` branch on desktop — replace that branch with the typeset lockup. Leave `logoHasWordmark: true` in config so other `logoSrc` consumers still treat the SVG as a full wordmark.

- [ ] **Step 3: Recolor `ProBadge`**

Replace the active/hover violet classes:

```tsx
active
  ? [
      'border-primary/70 bg-primary text-primary-foreground',
      'shadow-[0_0_0_3px_color-mix(in_srgb,var(--primary)_14%,transparent)]',
    ]
  : [
      'border-border bg-background/70 text-muted-foreground',
      'hover:border-primary/70 hover:bg-primary/10 hover:text-primary',
    ]
```

Do not change `role="switch"`, `data-testid`, or `onClick={onToggle}`.

- [ ] **Step 4: Commit (only if the user asked)**

```bash
git add components/workbench/workspace-shell.css components/workbench/workspace/WorkspaceHome.tsx components/workbench/ProBadge.tsx
git commit -m "feat(workspace): align Pro home with Qingjin tokens"
```

---

### Task 7: Verification gate

**Files:** none (run only)

**Interfaces:**
- Consumes: scripts documented in `README-zh.md` and `package.json`
- Produces: pass/fail evidence for spec §12

- [ ] **Step 1: Command-line checks (repo root, existing toolchain)**

```bash
pnpm lint
pnpm check:i18n-keys
pnpm test
pnpm build
```

Each must exit 0. If `pnpm install` is ever required, run it only in this repo per README-zh.md. Do not install global CLIs. Do not point the store at a new C: path.

- [ ] **Step 2: Human smoke (README-zh.md start path)**

```bash
pnpm dev
```

or `pnpm build && pnpm start`. Then on desktop:

1. Generate a course (开课).
2. Open a historical course.
3. Search the library.
4. Create / rename / open a folder (move if drag works).
5. Import ZIP (file picker opens).
6. Open and close Settings.
7. Theme: light ↔ dark ↔ system.
8. Pro Workspace badge on and back.

Out-of-round pages may look celadon. Broken handlers fail the gate.

- [ ] **Step 3: Visual acceptance grep**

```bash
rg "violet|#722ed1|#8b47ea" app/page.tsx components/workbench/workspace/WorkspaceHome.tsx components/workbench/ProBadge.tsx components/workbench/workspace-shell.css
```

Expected: no brand-violet leftovers on Round 1 surfaces.

- [ ] **Step 4: Confirm the image contract**

- `/qingjin-mark.svg` and `/qingjin-lockup.svg` exist under `public/`.
- `<md` Workspace header still uses `<img src={brand.logoSrc}>`.
- Footer string is `t('home.footer')`.
- Top bar has no “OpenMAIC” wordmark.

---

## Self-review

1. **Spec coverage:** identity §2 → Task 1; tokens/type §3–4 → Task 2; IA/surfaces §5–6 → Tasks 4–6; copy §7 → Task 3; files §8 → file map; behaviour §9 → “classes only” steps; motion §10 → orb removal + existing motion; quality §11 + verification §12 → Task 7.
2. **Placeholders:** none. Commands, strings, and class maps are explicit.
3. **Type consistency:** `logoSrc` / `markSrc` / `logoHasWordmark` / `home.headline` / `home.footer` match across tasks.
