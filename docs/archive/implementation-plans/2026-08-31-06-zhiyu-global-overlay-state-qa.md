# ZHIYU Global Overlays, State Coverage, and Release QA Plan

Status: **Accepted — execute after Plans 01–05 under the confirmed Q1–Q5 decisions**

**Goal:** Close the cross-route gaps that cannot be owned cleanly by a single product page and prove the redesign across Docker, responsive layouts, themes, and accessibility-critical interactions.

**Spec:** `zhiyu-implementation-plans/2026-08-31-zhiyu-full-ui-redesign-v2.md`

**Coverage contract:** `zhiyu-implementation-plans/2026-08-31-00a-zhiyu-ui-coverage-audit-and-surface-matrix.md`

## Global constraints

- Presentation and test changes only; do not change business-state ownership.
- Generated learning content is a fidelity boundary, not a ZHIYU skin target.
- Do not add fake data to make empty or analytics-like states look complete.
- Docker port 3000 is the release target; existing Playwright port 3002 is only the development-test target.

## Task 1: Repair and lock the Docker verification path

- [ ] Reproduce the current Turbopack/webpack production-build conflict.
- [ ] Resolve the `node:sqlite`/`undici` server-bundle failure with the smallest build/config-only change.
- [ ] Build with the official Tsinghua Alpine and npmmirror npm arguments.
- [ ] Add a Docker-specific Playwright config targeting `http://localhost:3000` with no local `webServer` startup.
- [ ] Prove container startup and the Home health check before UI screenshots.

## Task 2: Global chrome and overlay contract

- [ ] Add stable selectors and tests for Access Code initial/invalid/loading/success states.
- [ ] Apply ZHIYU tokens to Access Code, Toast, storage-health, and global fallback surfaces.
- [ ] Verify focus trap, Escape, focus return, live-region behavior, and icon labels.
- [ ] Ensure metadata, favicon/brand source, and attribution are consistent on every product route.

## Task 3: Fill route-owned loading, empty, and error gaps

- [ ] Standalone Classroom load/missing/error/retry in `app/classroom/[id]/page.tsx`.
- [ ] Hosted Classroom load/missing/error in `ClassroomSurface`.
- [ ] Generation bootstrap, no-session, review-error, retry, and Agent Reveal states.
- [ ] Workspace Suspense/loading and feature-off/feature-on entry behavior.
- [ ] Compatibility Bridge forwarding/error/retry.
- [ ] Home library, folder, search, import, and persistence states.

## Task 4: Secondary overlay inventory gate

- [ ] Home theme/profile/folder/course/search/import/model overlays.
- [ ] Settings all sections and provider/model confirmation families.
- [ ] Classroom settings/share/export/video-export and whiteboard/roles/chat overlays.
- [ ] Editor roster/insert/color/image/table/context/quiz/scene-switch overlays.
- [ ] PBL submission/viewer and Quiz owned overlays as generated-content boundary checks.

## Task 5: Responsive and dark-mode matrix

- [ ] Tier A at 800, 1024, 1366, and 1600 widths.
- [ ] Tier B at 800/1024 and 1366 widths.
- [ ] Light and dark snapshots at 1366 for Tier A/B.
- [ ] No horizontal page overflow, clipped primary action, inaccessible rail/panel, or overlapping dialog footer.
- [ ] Confirm Classroom rail/interaction access below 900 through drawer/sheet presentation.

## Task 6: Accessibility-critical interactions

- [ ] Keyboard-only smoke path across Home → Generation → Classroom → Editor → Settings.
- [ ] Visible focus for all icon-only and compact actions.
- [ ] Dialog focus lifecycle and screen-reader names.
- [ ] Loading/error announcements and actionable recovery copy.
- [ ] Reduced-motion path for decorative transitions.
- [ ] Contrast review for brand green, AI blue, danger/coral, disabled controls, and dark mode.

## Task 7: Full regression and visual comparison

- [ ] Run lint, i18n key check, Vitest, targeted E2E, full E2E, and production build.
- [ ] Run the Docker-specific E2E/screenshot suite against port 3000.
- [ ] Compare each Tier A/B implementation screenshot with its selected source target at the same viewport and state.
- [ ] Exercise the deterministic competition demo without external paid generation when a fixture can represent the state.
- [ ] Record every unverified external-provider or feature-flag state as an explicit limitation.

## Exit criteria

- Every row in the Surface Matrix has an owner, implementation task, automated or manual evidence, and an explicit scope decision.
- No visible 青衿/书院/primary-purple product branding remains in product chrome.
- No generated learning content is polluted by global ZHIYU tokens.
- Docker image builds using the documented mirror arguments and the container passes the port-3000 UI gate.
- Behavior-preservation tests pass for generation, playback, both Chat systems, persistence, provider settings, and editor commands.
