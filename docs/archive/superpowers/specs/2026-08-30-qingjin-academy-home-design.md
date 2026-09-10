# 青衿书院 — Round 1 Homepage Visual Design

Date: 2026-08-30

Status: approved for planning (user amendments applied)

Scope: first-round UI of `/` (classic home) and Workspace home
Selected direction: **Scheme A · 青衿书院**

## 1. Goal

Restyle OpenMAIC into a competition-ready AI education product named **青衿**, without changing generation, orchestration, playback, providers, or storage.

Round 1 only covers the surfaces a judge sees first:

- classic homepage `/`
- Workspace home (`WorkspaceHome`)
- top navigation on those two surfaces
- AI composer / generate area
- recent course / folder cards
- global visual tokens that those surfaces read

Success for a 3-minute desktop demo:

1. The page is recognizably **not** stock OpenMAIC (no violet `#722ed1`, no blue/purple glow orbs).
2. A judge can read the product as a **Chinese academic teaching studio**.
3. The existing generate / open-course / folder / search / import / settings flows still work with the same handlers.

## 2. Product identity

OpenMAIC is the upstream project, not an English or legal name for 青衿.

| Role | Value |
|---|---|
| Product brand | 青衿 |
| English name | none for this round |
| Short name | 青衿 |
| Attribution | 基于 OpenMAIC |
| Lockup (desktop type) | Songti wordmark **青衿** + a 14px square bronze seal. Do **not** put OpenMAIC in the top bar. |
| Footer / About | `青衿 · 基于 OpenMAIC 的 AI 教学工作台` |
| Theme color / browser chrome | `#3D6B5A` |
| Page title | `青衿` |
| Description | `一句话，生成一堂多智能体互动课。` |

`lib/brand/brand-config.ts` is the single source of truth. Values are locked:

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

Asset contract (not optional):

| Field | Path | Why it is required |
|---|---|---|
| `markSrc` | `/qingjin-mark.svg` | Favicon / square mark / rail |
| `logoSrc` | `/qingjin-lockup.svg` | `WorkspaceHome` compact header (`<md`) renders `brand.logoSrc` as an `<img>` |
| `logoHasWordmark` | `true` | Desktop `WorkspaceHome` skips the separate text name when the image already has a wordmark |

Desktop Hero on `/` and desktop Workspace lockup may keep **typeset** 青衿 + seal and need not display the SVG. The SVG exists so mobile Workspace and any other `logoSrc` consumer do not 404 or fall back to the old OpenMAIC PNG.

Keep old `/logo-horizontal.png` and `/openmaic-mark.png` on disk so leftover references do not 404. Do not invent a second brand file. Workspace rail, home hero, and metadata all keep reading `useBrand()` / `DEFAULT_BRAND`.

## 3. Visual tokens

Replace the global primary and the homepage canvas. Do not introduce a parallel color system that fights shadcn.

### 3.1 Light (default, demo-first)

| Token | Hex | Use |
|---|---|---|
| Paper | `#F4F6F3` | Page canvas |
| Porcelain | `#FBFCFB` | Cards, composer, top bar |
| Ink | `#1B2420` | Headlines, primary text |
| Muted | `#5C6B64` | Slogan, meta, placeholders |
| Celadon | `#3D6B5A` | Primary button, focus, active, brand |
| Celadon soft | `#3D6B5A14` | Selected / hover wash |
| Bronze | `#8A6A3D` | Seal only; never large fills |
| Line | `#1B242014` | Hairline borders |
| Destructive | keep existing shadcn red | Delete confirm only |

`--primary` becomes `#3D6B5A`. `--primary-foreground` is porcelain/white. `--background` is Paper. `--foreground` is Ink. `--radius` stays `0.625rem` so shadcn controls do not jump.

Global `--primary` / `--background` / `--foreground` changes are **intentional** and will recolor existing shadcn controls outside Round 1 (classroom chrome, chat, settings interior, generation-preview). Those surfaces get **smoke testing only**, not a component-level redesign. Do **not** invent a homepage-only primary token — a second color system is forbidden.

### 3.2 Dark

Keep system dark mode working. Do not design a second showcase theme.

| Token | Hex |
|---|---|
| Paper | `#121816` |
| Porcelain | `#1A221F` |
| Ink | `#E8EEEA` |
| Muted | `#9AA89F` |
| Celadon | `#7FA392` |
| Bronze | `#C4A574` |

No cyan/violet leftover classes (`violet-*`, `purple-*`, `bg-blue-500/10`) on the round-1 surfaces. Replace them with celadon / ink utilities or CSS variables.

### 3.3 What is forbidden

- Purple / violet brand color
- Blue + purple pulsing orbs
- Rainbow or “AI nebula” gradients
- Acid neon
- Warm cream + terracotta (generic AI landing)
- Near-black + acid green
- Newspaper broadsheet chrome

Allowed atmosphere: a **very faint** celadon wash in the upper third (opacity ≤ 6%), no animation pulse. Grain optional at ≤ 4% opacity, static.

## 4. Typography

| Role | Face | Size / weight |
|---|---|---|
| Display (wordmark, hero headline) | Noto Serif SC (`@fontsource/noto-serif-sc`) | Wordmark 28–32px, headline 28–36px, weight 700 |
| UI / body | keep Inter Variable + existing CJK fallback | 13–15px |
| Meta / instrument | existing sans, tabular nums | 11–12px, muted |

Reuse the already-installed `@fontsource/noto-serif-sc` (400 and 700 are imported today in `app/editor-fonts.ts`). Import those same stylesheets from the root layout (or a tiny `app/display-font.ts` imported by `app/layout.tsx`) so the homepage does not wait on editor preload. Map the family to `--font-display`. **Add no new dependencies.** Do not replace Inter globally — classroom playback and editors stay on the current stack.

Chinese copy is the default voice on `/`. English locale keeps English strings; only `zh-CN` is rewritten for the hero.

## 5. Homepage information architecture

Keep the current column. Do not add a sidebar on `/`.

```
┌─────────────────────────────────────────────────────────┐
│  青衿 [印]                       语言  主题  设置        │  48-56px top bar
├─────────────────────────────────────────────────────────┤
│                                                         │
│              一句话，生成一堂课                           │
│           多智能体教师与同学，实时讲授与讨论               │
│                                                         │
│         ┌─────────────────────────────────┐             │
│         │ 嗨，同学              AgentBar   │             │
│         │ 输入区                           │             │
│         │ 材料 / 搜索 / 交互    [开课]     │             │
│         └─────────────────────────────────┘             │
│                                                         │
│  ──────────── 最近课堂 (n)  搜索 导入 新文件夹 ───────── │
│  [文件夹] [课程卡] [课程卡] [课程卡] [课程卡]             │
└─────────────────────────────────────────────────────────┘
```

Rules:

- Desktop demo first: compose at `max-w-[800px]`, library at `max-w-6xl`, as today.
- Hero sits in the first viewport. Library stays below, not a second landing page.
- No marketing feature grid, no testimonials, no extra CTA besides 开课.
- Footer becomes `青衿 · 基于 OpenMAIC 的 AI 教学工作台` (small, muted). This is the only homepage place that names OpenMAIC.

## 6. Surfaces

### 6.1 Top navigation (classic home)

Replace the floating right-hand pill with a **real product bar**:

- Left: lockup (serif 青衿 + bronze seal only). OpenMAIC attribution stays in the footer, not the bar.
- Right: the same three controls that already exist — `LanguageSwitcher`, theme menu, settings gear — restyled as quiet text/icon buttons, not a candy pill.
- Bar treatment: porcelain / 72% blur, 1px Paper-line, no heavy shadow.
- `SettingsDialog` open/close and theme handlers stay as they are. Only wrappers and classes change.
- Do not move these controls into `components/header.tsx`. That file is the **classroom** chrome and is out of round 1.

### 6.2 Hero

- Remove `/logo-horizontal.png` from the visual hero (keep the file; brand lockup is type + seal).
- Headline (`zh-CN`): `一句话，生成一堂课`
- Slogan (`zh-CN`): `多智能体教师与同学，实时讲授与讨论`
- `en-US` headline/slogan may stay English and equivalent in meaning.
- Pro badge stays absolutely at the lockup shoulder when workbench is enabled. Recolor its active/idle styles from violet to celadon. Do not change `startProSwap` / `enterWorkbench`.

### 6.3 Composer (generate area)

Keep `GreetingBar`, `AgentBar`, textarea, `GenerationToolbar`, `InteractiveModeButton`, `SpeechButton`, and the generate button. Change skin only:

- Porcelain surface, 16–20px radius, 1px ink hairline, soft contact shadow (`0 1px 0` + `0 12px 32px` at 4% ink).
- Focus: 1px celadon ring + a 6% celadon wash. No violet glow.
- Textarea: 13–14px, min-height unchanged, `Ctrl/Cmd+Enter` unchanged.
- Primary button label in `zh-CN`: `开课` (key `toolbar.enterClassroom`). Disabled state: muted porcelain, not grey-on-grey collapse.
- Greeting hover ring: celadon, not violet.
- Vocational test chip (if shown): restyle cyan → celadon/bronze. Do not remove the flag-gated control.

### 6.4 Recent courses

- Section trigger stays a divider + `最近课堂` + count + chevron.
- Search / import / new-folder actions stay; restyle hover from violet/muted-grey to celadon/ink.
- Folder tiles and course cards keep the same props and handlers (`onOpen`, `onRename`, `onDelete`, drag-to-folder, overlay menus).
- Course card:
  - 16:9 thumbnail, `rounded-2xl`, hover scale `1.02` kept
  - empty state icon: celadon wash, not violet-to-blue gradient
  - meta pill: celadon-soft background + celadon text, e.g. `8 页 · 今天`
  - search-folder badge: celadon, not `violet-500/80`
  - rename underline: celadon
- Empty / search-empty copy stays on existing i18n keys.

### 6.5 Workspace home

`WorkspaceHome` must feel like the same product, not a second skin.

- Update `.ws-root` canvas tokens in `workspace-shell.css` from slate/violet to Paper / Celadon.
- Composer focus thread: celadon, not violet.
- Desktop (`md+`) lockup is typeset 青衿 + seal (same as `/`). Compact (`<md`) header keeps `<img src={brand.logoSrc}>` and therefore requires `/qingjin-lockup.svg`.
- Keep `data-pro-morph` hooks so Pro swap still lines up.
- Do not change rail tree behavior, session open, or `ProLaunchPanel` props.

## 7. Copy (zh-CN)

Only keys the hero and primary CTA need for the demo:

| Key | New value |
|---|---|
| `home.slogan` | `多智能体教师与同学，实时讲授与讨论` |
| `home.headline` (add) | `一句话，生成一堂课` |
| `home.footer` (add) | `青衿 · 基于 OpenMAIC 的 AI 教学工作台` |
| `toolbar.enterClassroom` | `开课` |
| metadata title/description | see §2 |

Do not rewrite the whole locale file. `home.headline` and `home.footer` must be added to **every** locale under `lib/i18n/locales/` so `pnpm check:i18n-keys` passes. Non-zh-CN locales use an English-meaning fallback (see plan).

## 8. Files in scope

Allowed to change:

- `app/page.tsx` — classes, lockup markup, top bar structure; **no** handler / state / storage changes
- `app/globals.css` — tokens, display font, remove homepage orb styles if any live here
- `app/layout.tsx` — metadata; import existing `@fontsource/noto-serif-sc` 400/700 (no new package)
- `lib/brand/brand-config.ts` — locked identity in §2
- `tests/lib/brand/brand-config.test.ts` — expect 青衿 + SVG paths + celadon
- `lib/i18n/locales/*.json` — keys in §7 (all 12 locales)
- `components/workbench/workspace-shell.css` — canvas / accent tokens
- `components/workbench/workspace/WorkspaceHome.tsx` — lockup presentation
- `components/workbench/ProBadge.tsx` — color classes only
- `components/generation/generation-toolbar.tsx` — homepage-visible violet classes → celadon
- `components/generation/interactive-mode-button.tsx` — color classes only if they hardcode cyan/violet
- `components/discovery/folder-card.tsx` — color classes only
- `components/discovery/folder-dialogs.tsx` — focus ring classes only
- `components/discovery/move-to-folder-menu.tsx` — check/focus classes only
- `public/qingjin-mark.svg` — square bronze seal (required)
- `public/qingjin-lockup.svg` — horizontal 青衿 + seal wordmark (required; `logoHasWordmark: true`)
- Keep `/logo-horizontal.png` and `/openmaic-mark.png` so leftover references do not 404. Do not add an “optional” third lockup.

Out of scope this round:

- `components/header.tsx` (classroom playback chrome)
- `components/classroom/*`, `components/chat/*` beyond leftover violet if it leaks onto `/`
- generation pipeline, LangGraph, Action Engine, providers, Dexie/Postgres
- Docker / Hong Kong deploy
- renaming the npm package or repo

## 9. Behaviour contract

These must stay byte-identical in logic:

- `handleGenerate` session snapshot + `router.push('/generation-preview')`
- `canGenerate` = non-empty requirement + usable provider
- draft cache, webSearch / interactiveMode localStorage
- `listStages` / folders / search / import ZIP / PPTX flag
- Pro swap (`data-pro-morph`, `startProSwap`, runtime probe)
- Settings dialog sections
- GreetingBar profile edit (avatar, nickname, bio)

If a visual change requires wrapping a control, wrap it. Do not inline a new generate path.

## 10. Motion

- Keep the existing entrance (fade / 8–20px rise, ≤ 600ms).
- Remove `animate-pulse` background orbs.
- Hover: 150–200ms color / shadow. No bounce, no sparkle loops.
- Respect `prefers-reduced-motion`: skip entrance transforms.

## 11. Quality bar

- Desktop 1280–1512 first; basic stacking on <768 (top bar compresses, 2-column cards stay).
- Visible keyboard focus on composer, generate, settings, search.
- Contrast: Ink on Paper and porcelain button label on Celadon must meet AA.
- Add no new dependencies. Reuse existing `@fontsource/noto-serif-sc`.

## 12. Verification / Acceptance

Round 1 is not done until both command-line and human checks pass.

### 12.1 Command-line (required)

Run from the repo root (`D:\ZZGG_Innovation_Project\OpenMAIC-main`) using the scripts already in `package.json` / [README-zh.md](../../../../README-zh.md). Do not install global CLIs, do not `npm i -g`, do not change the user-level pnpm/npm store, and do not write extra caches onto the C: drive. Use the project’s existing `node_modules` and `pnpm`.

| Command | Must |
|---|---|
| `pnpm lint` | exit 0 |
| `pnpm check:i18n-keys` | exit 0 (new keys exist in every locale) |
| `pnpm test` | exit 0, including updated `tests/lib/brand/brand-config.test.ts` |
| `pnpm build` | exit 0 |

If a fresh install is ever required, run `pnpm install` only inside this repo, following README-zh.md. Never hoist tools to `%APPDATA%` / a global prefix for this work.

### 12.2 Human smoke (required)

On desktop, after `pnpm dev` or `pnpm build && pnpm start` (README-zh.md):

1. Generate a course from the new composer (开课).
2. Open a recent / historical course.
3. Search the library.
4. Create / rename / open a folder; move a course if drag is available.
5. Import a classroom ZIP (or confirm the control still opens the file picker).
6. Open Settings and close it.
7. Switch theme light ↔ dark ↔ system.
8. Toggle Pro Workspace (badge) and return.

Out-of-round surfaces (classroom header, chat, settings interior) only need a glance: they may be celadon instead of violet because `--primary` changed. That is accepted. Broken handlers are not.

### 12.3 Visual acceptance

- No `#722ed1` / `violet-*` / purple orbs on `/` or Workspace home.
- Top bar shows 青衿 + seal only.
- Footer is `青衿 · 基于 OpenMAIC 的 AI 教学工作台`.
- Mobile Workspace (`<md`) still shows an image at `brand.logoSrc` (`/qingjin-lockup.svg`).

## 13. Out-of-round follow-ups (do not start)

Classroom playback header, chat, generation-preview, settings interior, and Docker/HK deploy wait for later rounds. They may pick up the new `--primary` automatically; do not restyle them in this round.
