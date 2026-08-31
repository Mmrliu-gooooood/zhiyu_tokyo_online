# ZHIYU UI Design QA

## Contract and truth source

- Approved scope: `zhiyu-implementation-plans/2026-08-31-00-zhiyu-ui-roadmap.md` and the confirmed `2026-08-31-00a-zhiyu-ui-coverage-audit-and-surface-matrix.md`.
- Visual direction: [AI Educational Tool Web App](https://dribbble.com/shots/27167779-AI-Educational-Tool-Web-App).
- Product boundary: ZHIYU restyles product chrome and owned overlays only. Generated Slide, Quiz, Interactive, Whiteboard, and PBL content retain their renderer-owned presentation.
- Behavior boundary: existing generation, playback, chat, persistence, settings, and editor state owners and handlers remain authoritative.

## Visual evidence

Evidence directory:

`C:\Users\Lenovo\.codex\visualizations\2026\08\31\01a05731-385a-79e0-9f69-35d3f3610d6d\zhiyu-qa-screenshots-2026-08-31`

| Surface | Viewport/state | Evidence | Result |
|---|---|---|---|
| Source reference | 1280 px, light | `plan01-reference-1280.png` | Truth source captured |
| Home | 1280 px, light, default/disabled CTA | `plan01-home-1280.png`, `plan01-comparison.png` | Passed comparison after iteration |
| Generation | 1280 px, light, generating | `plan02-generation-1280.png`, `plan02-comparison.png` | Passed shell/timeline/preview comparison |
| Classroom | 1280 px, light, rail collapsed and expanded | `plan03-classroom-1280.png`, `plan03-classroom-expanded-1280.png`, `plan03-comparison.png` | Passed chrome/layout comparison |
| Final Home | approximately 1280 px, light, production image | In-app Browser live capture at `http://localhost:3001/` | Passed after reload and asset settlement; mark/avatar and primary controls rendered correctly |

The final production-image Home DOM review confirmed the ZHIYU lockup, language/theme/settings controls, hero, AI-teacher action, prompt composer, configuration/deep-interaction controls, disabled Start Class action, and course-library controls were present with accessible roles.

## Automated evidence

- `e2e/tests/zhiyu-home-ui.spec.ts`: brand, exact copy, disabled primary action, legacy-brand absence.
- `e2e/tests/zhiyu-generation-ui.spec.ts`: generation shell, timeline, preview, truthful active state.
- `e2e/tests/zhiyu-classroom-ui.spec.ts`: regions, selected scene, playback, tabs, one chat lifecycle, composer handler.
- `e2e/tests/zhiyu-workspace-ui.spec.ts`: feature-enabled Workspace rail and navigation.
- `e2e/tests/zhiyu-settings-ui.spec.ts`: settings regions and persistence.
- `e2e/tests/zhiyu-editor-ui.spec.ts`: editor regions, commands, selected scene.
- `e2e/tests/zhiyu-global-overlay-ui.spec.ts`: Access Code initial/invalid/loading/success, focus trap, inert background, live status.
- `e2e/tests/zhiyu-responsive-matrix.spec.ts`: Tier A at 800/1024/1366/1600 light plus 1366 dark; Tier B at 800/1024/1366 light plus 1366 dark; horizontal overflow guard and success screenshots.
- `.github/workflows/ci.yml`: builds the production Docker image with the documented mirrors, starts it on port 3000, runs the Docker-specific Playwright config, and uploads matrix screenshots.

## Release verification history

| Gate | Result |
|---|---|
| Docker prerequisite build fix | Passed and committed separately before UI work |
| Plan 01–06 targeted unit/contract tests | Passed at each plan boundary |
| Final Plan 06 frozen gate | 61/61 targeted tests; i18n 12/12 locales; ESLint 0 errors; production build 52 pages |
| Route regression contracts found in final review | Fixed by sharing constants outside Next route modules; 47/47 targeted tests passed in the Builder image |
| Exact mirror-argument Docker build before final review fixes | Passed |
| Final mirror-argument Docker build after review fixes | Passed; production build generated 52 pages and tagged `openmaic:local` |
| In-app Browser final production-image Home review | Passed on host port 3001 (container port 3000); final image returned HTTP 200 |

## Explicit limitations and blocked checks

- The user's existing `openmaic-main-openmaic-1` container owns host port 3000 and was intentionally not stopped or replaced. The exact final image is previewed safely on host port 3001 while still serving container port 3000.
- Workspace DOM capture in the in-app Browser was blocked by the Browser URL security policy. The restriction was not bypassed; Workspace evidence therefore comes from feature-enabled component/contract tests and the new Docker CI gate.
- Playwright CLI was not run locally because the selected in-app Browser workflow requires explicit permission before using it. The Docker Playwright gate and screenshot matrix are committed for CI execution.
- External paid-provider states are covered by deterministic fixtures or recorded as out of scope; no paid generation was invoked.

## Final disposition

Home, Generation, Classroom, Workspace, both chat presentations, Settings, Editor, global overlays, fallbacks, responsive drawers, dark-mode tokens, and accessibility-critical states have explicit implementation and test owners. The post-review Docker build, targeted regression, lint, i18n, and final in-app Browser Home review passed. The committed Docker Playwright state/viewport screenshot matrix remains a CI-only evidence gate and is not represented as locally executed.
