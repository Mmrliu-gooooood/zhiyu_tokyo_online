# ZHIYU Full UI Coverage Audit and Surface Matrix

Status: **Accepted implementation contract — all Q1–Q5 recommendations confirmed on 2026-08-31**

**Goal:** Replace the route-name-based plan with a surface-and-state contract that covers every user-facing frontend state without changing OpenMAIC business behavior.

**Canonical visual spec:** `zhiyu-implementation-plans/2026-08-31-zhiyu-full-ui-redesign-v2.md`

**Architecture decision:** `docs/adr/0001-redesign-product-chrome-without-moving-business-state.md`

## 1. Audit verdict

The existing Plans 01–05 cover the main Home → Generation Preview → Classroom demo path, Workspace, Settings, and Editor at a high level, but they do **not** cover every frontend surface. Implementation must not begin until Plans 01–05 are expanded using this matrix and Plan 06 is included in the execution graph.

Confirmed gaps:

- root Access Code, Toast, and storage-health overlays;
- Home menus, profile editor, folder/course dialogs, search/import/empty/error states;
- Generation session loading/missing, complete outline-review controls, truncation warning, and Agent Reveal;
- standalone Classroom route states, which are not owned by `ClassroomSurface`;
- Workspace home/conversation/classroom/combined pane permutations, both Chat subsystems, and rail states;
- `/workbench/new` loading/failure/retry bridge;
- all Settings sections and nested provider/model/confirm dialogs;
- Editor roster, insert, color, image, table, context, quiz, and scene-switch overlays;
- Quiz, Interactive, Whiteboard, and PBL content surfaces as fidelity-regression boundaries;
- systematic viewport, theme, keyboard/focus, and reduced-motion evidence;
- Docker-specific build, startup, health, and browser verification.

## 2. Route inventory and scope

| Route | Product role | Redesign scope | Required states |
|---|---|---|---|
| `/` | Home | Full ZHIYU redesign | default, disabled create, populated library, empty library/folder/search, importing, import error, menus, profile, folder/course dialogs |
| `/generation-preview` | Classic generator | Full ZHIYU chrome redesign | session loading, session missing, outline review, validation/error, active generation, partial/retry, complete, Agent Reveal |
| `/classroom/[id]` | Standalone classroom | Full ZHIYU chrome redesign | load, missing/error/retry, playback, paused, discussion, roles, whiteboard, edit, settings, share/export, fullscreen |
| `/workspace` | Optional Pro workbench | Full ZHIYU chrome redesign when feature-enabled | home, conversation, classroom, combined panes, rail collapsed/open, session/course/folder loading/empty/error/rename/delete |
| `/workbench/new` | Compatibility Bridge | Brand-consistent utility state only | forwarding, failure, retry |
| `/eval/whiteboard` | Evaluation Surface | No product redesign | functional/visual regression only |

API routes and server-render-only artifacts are outside the UI scope. The current upstream session-title persistence update is also outside this redesign and must not be copied into UI commits.

## 3. Global surface matrix

| Surface | Owner/evidence | Required design contract |
|---|---|---|
| Global tokens and fonts | `app/globals.css`, `app/layout.tsx` | ZHIYU canvas/surface/text/action roles; no serif/academy branding; generated content isolation |
| Metadata and brand source | `app/layout.tsx`, `lib/brand/brand-config.ts` | `智域 / ZHIYU`; exact slogan/supporting copy; OpenMAIC attribution |
| Access Code | `components/access-code-modal.tsx` | initial, invalid, validating, success; keyboard/focus recovery; no legacy branding |
| Toasts | root Toaster and call sites | info/success/warning/error contrast in both themes; non-blocking live-region behavior |
| Storage health | root storage notice | loading/degraded/error/recovered; truthful persistence messaging |
| Global fallbacks | route-level inline states and Suspense | no blank fallback; meaningful status and recovery action |

## 4. Product surface matrix

### 4.1 Home — expand Plan 01

- Brand lockup, header language/theme/settings controls, exact copy, attribution.
- Create card: greeting/profile trigger, agent roster, prompt, materials, model configuration, deep-interactive, speech, disabled/enabled/generating transitions.
- Library: recent/folder/search modes, populated/empty/empty-folder/no-results/loading/persistence-error.
- Overlays: theme menu, profile view/edit, new/rename/delete folder, rename/delete/move course, search, import, model configuration, settings launch.
- Preserve all existing creation, import, folder, search, settings, Profile, and Pro-swap handlers.

### 4.2 Generation Preview — expand Plan 02

- Session bootstrap loading and session-missing recovery.
- Full outline-review editor, including quiz/interactive/PBL configuration popovers, validation and streaming errors.
- Truthful generation timeline projected only from existing state.
- Current-scene preview, truncated-input warning, retry/partial completion, final classroom CTA.
- Agent Reveal modal and entry action.
- Preserve sessionStorage handoff, review/retry semantics, generation APIs, and classroom redirect.

### 4.3 Classroom — expand Plan 03

- Treat `app/classroom/[id]/page.tsx` standalone states and `ClassroomSurface` hosted states as separate owners.
- Standalone load, missing, error, retry, and populated classroom.
- Header, Scene Rail, Learning Stage, Interaction Panel, Playback Bar, chat, roles, whiteboard, settings, share/export, fullscreen, and editor entry.
- Hosted Workspace classroom with host-owned chrome suppression.
- Generated Slide/Quiz/Interactive/Whiteboard/PBL content is not reskinned; it receives fidelity screenshots and interaction regressions.
- PBL v2 submission/viewer and Quiz empty/add/edit states are explicitly included as content-boundary overlays.

### 4.4 Workspace and both Chats — expand Plan 04

- Feature-off redirect is documented; full audit/implementation requires a feature-enabled Docker profile.
- Workspace home, conversation-only, classroom-only, and combined multi-pane states.
- Rail: collapsed/open, sessions/courses/folders loading/error/empty, rename/delete, settings entry.
- Workspace home CTA and realistic empty/recent states using real data only.
- Classic Chat (`components/chat`) and Workbench Conversation (`components/workbench/chat`) each get their own message, streaming, tool, attachment, ask-user, error, empty, and composer contracts.
- Compatibility Bridge receives branded forwarding/failure/retry states without becoming an independent product page.

### 4.5 Settings and Editor — expand Plans 04–05

- Cover every Settings navigation entry exposed by the current build: token plan, providers/language models, agents where enabled, image, video, TTS, ASR, PDF/document parsing, web search, skills, and general/system settings.
- Nested provider/model add/edit/delete/reset/test/fetch dialogs and validation/error states are included.
- Editor shell plus roster, insert, color, background/image, table, context menus, quiz empty/add/edit, scene switching, save/undo/redo/preview, share/export, and video-export dialogs.
- Preserve Settings persistence/actions and editor document/canvas behavior.

## 5. State, viewport, theme, and accessibility coverage

Do not require a wasteful full Cartesian product for every surface. Use the following tiered matrix:

| Tier | Surfaces | State coverage | Viewports | Themes |
|---|---|---|---|---|
| A | Home, Generation, Standalone Classroom, Workspace combined | all reachable default/loading/empty/error/disabled/success plus key overlays | 800, 1024, 1366, 1600 | light and dark at 1366; light at all widths |
| B | Settings, Editor, both Chats, Hosted Classroom | every primary state and every nested dialog family | 800/1024 and 1366 | light and dark at 1366 |
| C | Compatibility Bridge, Access Code, notices, content-boundary renderers | each owned state | one narrow and one desktop width | theme most likely to expose contrast risk |

Accessibility gates for all Tier A/B surfaces:

- visible focus and logical keyboard order;
- dialog focus trap, Escape, and focus return;
- names/labels for icon-only actions;
- contrast review in both themes;
- no horizontal page overflow at 800/1024;
- meaningful loading/error announcement and recovery action;
- reduced-motion path for non-essential transitions;
- touch targets remain usable on narrow layouts.

## 6. Current visual evidence

The audit was captured from the running Docker app at `http://localhost:3000` on 2026-08-31. Evidence is stored in `zhiyu-implementation-plans/audit-screenshots-2026-08-31/`.

| Step | Evidence | Health |
|---|---|---|
| 1 | `01-home.png` | Structurally usable; legacy 青衿/serif/academy visual remains and exact ZHIYU copy is absent |
| 2 | `02-home-settings.png` | Functional dense Settings modal; needs ZHIYU hierarchy and exhaustive nested-state contract |
| 3 | `03-workspace-home.png` | Feature-off build redirects `/workspace` to Home; feature-enabled state remains uncaptured |
| 4 | `04-generation-no-session.png` | Recovery works; isolated legacy card is outside the planned ZHIYU shell |
| 5 | `05-classroom-missing.png`, `06-classroom-missing-final.png` | Missing ID remains in full classroom loading chrome with enabled-looking controls; no terminal recovery observed |
| 6 | `08-home-800px.png` | No horizontal overflow observed; hierarchy remains desktop-like and very sparse |
| 7 | `09-home-dark.png` | Dark mode renders, but content/action contrast is visibly too low |

Evidence limits:

- The current Docker image was already running and did not enable Workspace/Pro persistence, so Workspace multi-pane states could not be captured.
- No valid seeded classroom was created during this read-only audit; populated classroom/editor states rely on code/test inventory until a deterministic fixture is added.
- Screenshot review identifies risks but does not prove WCAG compliance or keyboard behavior.

## 7. Docker and verification gate

Use the official slow-network build parameters:

```bash
docker build \
  --build-arg ALPINE_MIRROR=mirrors.tuna.tsinghua.edu.cn \
  --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
  -t openmaic:local .
```

Before UI implementation, resolve the current production build failures without changing product behavior:

1. `next build` currently selects Turbopack while `next.config.ts` defines webpack customization.
2. Forcing webpack exposes a `node:sqlite` import through `undici` in the server agent runtime.
3. Record the selected build fix in a separate build/config commit and prove `docker build` passes before relying on container visual tests.

Docker UI verification must target port 3000 without starting Playwright's existing port-3002 development server. Add a Docker-specific Playwright config or an equivalent explicit `baseURL=http://localhost:3000` path with no `webServer` block.

## 8. Execution graph

1. Confirm this Surface Matrix and the open decisions in Section 9.
2. Repair Docker production build and add Docker-specific test configuration.
3. Expand Plans 01–05 so every matrix row maps to an implementation task and test.
4. Execute Plan 01 → 02 → 03; pass the P0 Docker screenshot gate.
5. Execute Plan 04; use a feature-enabled Workspace fixture/profile.
6. Execute Plan 05; finish Editor and demo-path dialogs.
7. Execute Plan 06 for global overlays, responsive/dark/accessibility, and full release regression.
8. Compare source target and implementation screenshots at matching viewport/state before handoff.

## 9. Accepted Q1–Q5 decisions

The user accepted every recommended answer on 2026-08-31:

1. **Q1 — Product scope and content boundary:** exclude `/eval/whiteboard` from product reskin and regression-test it only. Do not reskin generated Slide/Quiz/Interactive/Whiteboard/PBL content; redesign only surrounding chrome and owned overlays.
2. **Q2 — Verification scale:** use the tiered matrix in Section 5 instead of a full state × width × theme Cartesian product.
3. **Q3 — Docker prerequisite:** authorize minimal Docker/build-config fixes in the implementation conversation, isolated from UI commits and without changing business behavior.
4. **Q4 — Upstream policy:** freeze the current local behavior baseline; do not sync unrelated upstream session-title persistence work into the redesign.
5. **Q5 — Brand contract:** replace all product-chrome 青衿/书院 language with `智域 / ZHIYU`, preserving `基于 OpenMAIC 构建` attribution.

The coverage contract is approved for implementation in a new conversation. No UI implementation was performed in the planning conversation.
