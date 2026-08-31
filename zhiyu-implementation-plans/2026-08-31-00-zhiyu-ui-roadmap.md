# ZHIYU Full UI Redesign — Implementation Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement each plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the approved ZHIYU V2 design into a competition-ready product without changing OpenMAIC's core generation, playback, chat, storage, provider, or course data behavior.

**Architecture:** Execute the redesign as a coverage contract plus six independently shippable plans. Plan 00A inventories every surface and state. Plans 01–03 are P0 and must produce a complete Home → Generation Preview → Classroom demo path before P1/P2 work begins. Plans 04–05 deepen consistency in Workspace, Chat, Settings, and Editor; Plan 06 closes global overlays, route-owned fallbacks, responsive/dark/accessibility gaps, and the Docker release gate.

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind CSS 4, Radix/shadcn primitives, Zustand, Vitest, Playwright.

**Spec:** `zhiyu-implementation-plans/2026-08-31-zhiyu-full-ui-redesign-v2.md`

**Coverage contract:** `zhiyu-implementation-plans/2026-08-31-00a-zhiyu-ui-coverage-audit-and-surface-matrix.md`

**Decision status:** All recommended Q1–Q5 scope, verification, Docker, upstream, and brand decisions were accepted on 2026-08-31. Implementation is intentionally deferred to a new conversation.

## Global Constraints

- Product name is exactly `智域`; English display name is exactly `ZHIYU`.
- Main slogan is exactly `一句话，生成一堂互动课`.
- Supporting copy is exactly `多智能体教师与同学，实时讲授与讨论`.
- Attribution is `基于 OpenMAIC 构建`; do not represent OpenMAIC as ZHIYU's English name.
- No Songti/serif brand lockup, bronze seal, academy/book-scroll visual language, or literary-themed branding.
- Primary brand color is `#356B59`; AI status color is `#5277B6`; lavender is secondary AI/Agent semantics only.
- Generated course/slide content keeps its own colors; ZHIYU tokens apply only to product chrome.
- Do not add fake homework, calendar, completion percentages, streaks, grades, or analytics without real data.
- Do not rewrite generation, orchestration, playback, Stage lifecycle, Chat lifecycle, storage, providers, or schemas.
- Preserve existing handler/state ownership; move visual containers around existing behavior rather than recreating handlers.
- No new UI framework or icon library; keep existing React/Tailwind/Radix/Lucide patterns.
- Desktop competition demo is the priority; preserve basic responsive behavior.
- Preserve dark mode functionality, but do not block P0 on pixel-perfect dark-mode polish.
- P0 must finish before P1/P2 begin.

---

## Plan Order

### P-1 — approve the complete UI boundary

0. `2026-08-31-00a-zhiyu-ui-coverage-audit-and-surface-matrix.md`
   - complete route/surface/state inventory
   - scope and exclusion decisions
   - Docker and visual evidence baseline
   - explicit user confirmation before implementation

### P0 — complete the judge-facing path

1. `2026-08-31-01-zhiyu-brand-home.md`
   - Brand migration
   - global tokens
   - reusable ZHIYU lockup
   - Home V2 creation card
   - course-library presentation
   - stable Home E2E selectors

2. `2026-08-31-02-zhiyu-generation-preview.md`
   - Generation shell
   - truthful timeline/status projection
   - current scene preview
   - outline-review preservation
   - generation E2E regression

3. `2026-08-31-03-zhiyu-classroom.md`
   - unified classroom header
   - scene rail
   - stage layout
   - interaction panel
   - playback bar
   - loading/error shell
   - classroom E2E regression

### P1 — unify working surfaces

4. `2026-08-31-04-zhiyu-workspace-chat-settings.md`
   - Workspace chrome
   - Chat presentation
   - Settings information architecture
   - no business-hook rewrites

### P2 — polish and release gate

5. `2026-08-31-05-zhiyu-editor-final-qa.md`
   - Editor chrome polish
   - secondary dialogs
   - responsive/dark-mode pass
   - full regression
   - competition demo checklist

6. `2026-08-31-06-zhiyu-global-overlay-state-qa.md`
   - global overlays and route fallbacks
   - complete state/viewport/theme matrix
   - accessibility-critical interactions
   - Docker port-3000 release gate

---

## Cross-Plan Gates

- [ ] After Plan 01: `pnpm lint`, `pnpm check:i18n-keys`, targeted Home E2E, `pnpm build`.
- [ ] After Plan 02: targeted generation tests + Home→Generation E2E + `pnpm build`.
- [ ] After Plan 03: classroom interaction + full happy path + `pnpm test` + `pnpm build`.
- [ ] Only then start Plan 04.
- [ ] After Plan 05: run the editor and secondary-overlay gate, then start Plan 06.
- [ ] After Plan 06: full `pnpm lint`, `pnpm check:i18n-keys`, `pnpm test`, production Docker build, Docker port-3000 E2E/screenshots, and the manual end-to-end demo run.

## Commit Policy

The current workspace has no commits and all project files appear untracked. Before implementation, initialize or restore the intended Git baseline. Do not execute plan commit commands until `git status` shows a normal tracked worktree. After that preflight, each task may end in a small commit such as:

```bash
git commit -m "feat(ui): add zhiyu brand primitives"
git commit -m "feat(home): redesign course creation surface"
git commit -m "feat(generation): add course construction shell"
git commit -m "feat(classroom): add interaction workspace layout"
```

Do not combine unrelated P0/P1/P2 edits in one commit.
