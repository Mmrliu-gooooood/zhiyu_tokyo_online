# ZHIYU frontend architecture Phase 0 baseline — 2026-09-02

Status: **Blocked; Phase 0 exit conditions are not met. Do not start Phase 1.**

This report records the baseline observed from the existing dirty worktree. No product source, UI, DOM, CSS, ARIA, route, server contract, Dockerfile, or Compose topology was changed.

## Protected worktree

- Branch: `main`
- HEAD: `ebd025461cc8e108f74dccac44b58c0b924212a4`
- Dirty state at the start of Phase 0:
  - modified: `CONTEXT.md`
  - untracked: `.scratch/`
  - untracked: `zhiyu-implementation-plans/2026-09-01-07-zhiyu-frontend-internal-architecture-optimization.md`
- Protected SHA-256 fingerprints:
  - `CONTEXT.md`: `8F238F0AF49448DA19882396A1E902008E9816EDDFE500E1EE88831C3983FA43`
  - architecture plan: `14AFC13257A1D7DDF2762297D7A27DCC99B74A1E3BA35AAE90DB56C9CFBF314C`
- No reset, clean, restore, checkout, or deletion command was run.
- Verification generated two untracked local artifacts: `.pnpm-store/` (8 KiB) and `debug.log` (Chromium media/GPU diagnostics). They were left in place because the Phase 0 safety rules prohibit deletion.

## Toolchain and topology

| Item | Observed value |
|---|---|
| System Node | `v18.19.0` (below package requirement `>=20.9.0`) |
| Baseline Node used for tests/build | `v24.19.0` from the bundled runtime |
| pnpm on PATH | `11.19.0` wrapper |
| cached pnpm used without dependency rewrite | `11.24.0`, with dependency verification set to warn |
| Docker image build pnpm | locked `10.28.0` from `Dockerfile` |
| Docker | `29.7.2` |
| Docker Compose | standalone `v5.4.0`; `docker compose` subcommand is unavailable |
| Compose profiles | `server-persistence`, `video-export` |
| Production image | `openmaic:phase0`, image id `sha256:3d5de8938db1067e2499e9b674ac3a35b620f32be11ac065fc04effe2f020585` |
| Runtime | `openmaic-phase0-e2e` on host `3000:3000`, PostgreSQL profile healthy |
| HTTP | `http://127.0.0.1:3000/` returned `200` |

## Quality gates

| Gate | Result |
|---|---|
| `pnpm lint` | passed with 0 errors and 18 warnings |
| `pnpm check:i18n-keys` | passed; 12 locale files aligned |
| `pnpm test` | failed: 641 files passed, 17 failed, 9 skipped; 6962 tests passed, 143 failed, 81 skipped; 206.20 s |
| `pnpm build` | passed; 52 static pages; existing webpack warnings for `unpdf`, optional `pg-native`, optional sharp packages, and Pi dynamic imports |
| Docker production build | passed using the same mirror and feature-on build args as CI |
| Docker port 3000 | passed; production Home returned HTTP 200 |
| Docker E2E, local 10 workers | failed: 56 passed, 16 failed; 1.2 min |
| Docker E2E, CI-equivalent 2 workers + 2 retries | failed: 55 passed, 17 failed; 7.1 min |

The first E2E attempt failed before test execution because Playwright Chromium v1208 was not installed. The locked Chromium, headless shell, FFmpeg, and Winldd were then installed into the Playwright user cache and the suite was rerun. The counts above are from real browser execution after that installation.

## Visual baseline

- The existing responsive matrix produced 24 successful screenshots:
  - Home: 5 (`800/1024/1366/1600` light, `1366` dark)
  - Generation Preview: 5 (same matrix)
  - Standalone Classroom: 5 (same matrix)
  - Settings provider dialog: 4
  - Editor: 4
  - Generation missing-session: 1
- Home and Standalone Classroom 1366-light screenshots were visually inspected and rendered the expected ZHIYU chrome.
- Workspace combined panes and Hosted Classroom produced no successful matrix screenshots. Every matrix case stopped before capture because `zhiyu-classroom-shell` was absent; the page snapshot showed the Workspace Classroom pane in Pro edit mode instead.
- The repository has screenshot evidence capture only. There is no `toHaveScreenshot`/golden assertion or committed pixel baseline, so Phase 0 Task 0.3 is not complete and current screenshots are not a regression gate.

Screenshot artifacts are under `test-results/` and the CI HTML report is under `playwright-report/`.

## Lifecycle and performance baseline

- Targeted existing lifecycle checks ran across owner EventSource, freshness sync, element-reference ownership, PlaybackChromeRoot ownership, Workspace StrictMode/bootstrap, and responsive drawer behavior: 77 passed, 1 failed.
- The failing lifecycle/accessibility assertion is `tests/components/classroom/zhiyu-classroom-shell.test.ts`: the open responsive drawer has `aria-modal="true"` but its expected `aria-label="Close scenes"` is `null`.
- The repository does not currently contain a test-only React Profiler seam for PlaybackChromeRoot or Workspace panes.
- Consequently, the required 100 speech/thinking update commit counts and p95 durations, Workspace Rail/Chat/Classroom commit counts, and 20-cycle timer/listener/EventSource/audio cleanup counts cannot be measured from the frozen production build. Phase 0 Task 0.4 is not complete; inventing proxy numbers would not be a valid baseline.

## Stable blockers

1. The full unit baseline is red. The dominant groups are Windows path separator/relative-path failures and 5 s timeouts in storage/runtime tests; at least one ZHIYU ARIA contract also fails directly.
2. CI-equivalent Docker E2E remains red after two retries. Stable failures include:
   - Generation outline review opportunity never appears in two flows; container logs include a real provider call using `test-key` and an outline stream abort, indicating the deterministic mock boundary is not complete.
   - Interactive iframe state resets from `3` to `0` across Pro mode/scene switching.
   - Playback cursor is still `null` after 60 s.
   - Quiz playback cannot find `Start Quiz`.
   - ZHIYU classroom play locator matches `Playback speed`, `Play`, and `Auto-play` and violates Playwright strict mode.
   - ZHIYU editor cannot find Undo.
   - Workspace combined/Hosted Classroom matrix cases enter the editor and never render `zhiyu-classroom-shell`.
3. Golden screenshot comparison is absent, and failed Workspace/Hosted states prevent a complete visual truth set.
4. React commit-duration and 20-cycle cleanup instrumentation is absent, so performance/lifecycle numbers are not yet measurable without adding test-only infrastructure.
5. The host default Node 18 and package-manager/dependency-layout mismatch make plain `pnpm` commands attempt dependency repair; Phase 0 used an explicit supported Node runtime and disabled automatic repair to protect the dirty tree.

## Disposition

Phase 0 is intentionally left **blocked**, with the production build and Docker/port-3000 availability proven but the unit, E2E, visual-golden, performance, and cleanup exit gates unmet. Phase 1 must not begin until these baseline blockers are handled as separate Phase 0 work.
