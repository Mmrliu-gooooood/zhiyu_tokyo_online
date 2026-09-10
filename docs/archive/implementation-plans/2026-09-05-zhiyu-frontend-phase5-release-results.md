# ZHIYU Frontend Internal Architecture Optimization — Phase 5 Release Results

Date: 2026-09-05

Baseline: `b2c66c8dbfa826ce5f536cfaddc0209ce6039ab8`

Release candidate: `ccfc26e7e226e541af355c067b2a9117211434f7`

Docker image: `openmaic:phase5` / `sha256:39c85bc46ca54080a13a4f68d5b1e95edee93a863eeaa779cdc75e661c0e2e62`

Status: **COMPLETE — READY FOR RELEASE**

## 1. Release decision

Phases 1–5 satisfy the architecture plan's exit conditions. The final release candidate preserves the existing rendered UI, DOM structure, CSS, ARIA, responsive breakpoints, routes, server interfaces, storage protocols, and Docker topology. PlaybackEngine, ChatArea, EventSource, audio, and generation resources retain a single explicit owner; no module-scope cross-request or cross-page runtime was introduced.

All architecture changes were driven through public-seam RED tests followed by minimum GREEN implementations. Deterministic regressions found during the work were fenced at their ownership boundaries. The final fixed-environment release gate is green without weakening assertions, visual thresholds, performance targets, timeouts, or retries.

## 2. Complete commit ledger

| Phase | Commit | Subject |
| --- | --- | --- |
| 1 | `bf5d1e8` | `refactor(classroom): narrow playback chrome stage projection` |
| 1 | `02466f7` | `fix(classroom): complete phase one projection contract` |
| 1 | `b3d5ff5` | `docs(zhiyu): record phase one architecture gate` |
| 2 | `7517b6f` | `refactor(classroom): isolate canonical runtime islands` |
| 2 | `8278a79` | `fix(classroom): close phase two review gaps` |
| 2 | `ab3479a` | `fix(classroom): fence all live session callbacks` |
| 2 | `23dab9d` | `fix(classroom): fence active bubble producers` |
| 2 | `95cbf3a` | `docs(zhiyu): record phase two architecture gate` |
| 3 | `ae639c2` | `fix(workbench): persist session title revisions` |
| 3 | `14ef3da` | `refactor(workspace): centralize runtime navigation islands` |
| 3 | `e597f22` | `fix(workspace): fence remount races and rail projection` |
| 3 | `c4e6f0c` | `fix(workspace): serialize title writes across remounts` |
| 3 | `33f2f3c` | `fix(workspace): preserve rename compatibility fencing` |
| 3 | `2b451f4` | `fix(workspace): preserve unchanged rename semantics` |
| 3 | `bda2c19` | `fix(workspace): retain queued rename evidence` |
| 3 | `17948a0` | `docs(zhiyu): record phase three architecture gate` |
| 4 | `640d84a` | `refactor(generation): own session phases and epochs` |
| 4 | `a9a1c02` | `fix(generation): fence candidate publication` |
| 4 | `6a1b805` | `fix(generation): transfer recoverable resource ownership` |
| 4 | `1201668` | `fix(generation): revoke failed sessions before cleanup` |
| 4 | `b9ad2b3` | `fix(generation): fence intents after terminal failure` |
| 4 | `0b99fe9` | `docs(zhiyu): record phase four architecture gate` |
| 5 | `661cfa5` | `test(performance): isolate zhiyu profiler gates` |
| 5 | `7328025` | `fix(test): preserve default playback coverage` |
| 5 | `71b78ca` | `fix(settings): restore focus when dialog closes` |
| 5 | `ccfc26e` | `fix(settings): preserve focus across nested launchers` |

The Phase 3 session-title change was ported by intent from upstream `9d16e68296dbfdf6002e0572fef98ea3689fee29`; it was not cherry-picked. Asynchronous `generate_video` remained out of scope.

## 3. Final release gate

The fixed test runtime matches Phase 0: Node.js 22.19.0 and the repository's pinned Vitest 4.1.8 peer installation.

| Gate | Result |
| --- | --- |
| Full Vitest | 668 files passed, 10 skipped; 7240 tests passed, 45 skipped; 0 failures; 96.33 s |
| Dedicated Playback performance | 8/8 passed, one fixed worker |
| Dedicated Workspace performance | 1/1 passed, one fixed worker |
| Cleanup and race suite | 7 files / 63 tests passed |
| i18n validation | 12/12 locale files passed |
| ESLint | 0 errors; 18 pre-existing warnings |
| Local production build | 52/52 routes generated |
| Docker production build | 52/52 routes generated |
| Settings keyboard/focus E2E | 3/3 passed |
| Full Docker E2E | 82/82 passed; 2 workers; 0 retries; 1.3 min |
| No-update responsive/golden | 41/41 passed; 1 worker; 0 retries; 1.2 min |
| Production browser performance | 1/1 passed |
| Standards review | No P0/P1/P2 findings |
| Specification review | No P0/P1/P2 findings |

The final container runs under its original name, port mapping, network, restart policy, environment, and PostgreSQL dependency. `/api/health` returns HTTP 200 and PostgreSQL is healthy. No additional mount or topology edge was introduced.

## 4. Phase 0 to final performance comparison

### Synthetic React profiler

| Metric | Phase 0 | Final | Change |
| --- | ---: | ---: | ---: |
| Playback speech root p95 | 5.643 ms | 0.078 ms | -98.6% |
| Playback thinking root p95 | 2.165 ms | 1.509 ms | -30.3% |
| Workspace Rail commits | 100 | 100 | 0% |
| Workspace Chat commits | 700 | 500 | -28.6% |
| Workspace Classroom commits | 300 | 200 | -33.3% |
| Workspace Rail duration p95 | 12.062 ms | 11.600 ms | -3.8% |
| Workspace Chat duration p95 | 3.342 ms | 3.228 ms | -3.4% |
| Workspace Classroom duration p95 | 12.903 ms | 17.506 ms | +35.7% |

The final thinking-only projection produces 0 Rail commits, 200 Chat commits, and 0 Classroom commits. Playback Header, SceneRail, and PlaybackBar produce zero commits for high-frequency stage-only updates. The Classroom duration p95 remains noisy and increased in the final sample even though its commit count fell by one third; this is retained as an explicit residual performance risk rather than hidden by a relaxed gate.

### Production browser sample

| Metric | Phase 0 | Final | Change |
| --- | ---: | ---: | ---: |
| Long-task count | 2 | 1 | -50.0% |
| Long-task total | 216 ms | 124 ms | -42.6% |
| Long-task maximum | 161 ms | 124 ms | -23.0% |
| LayoutCount | 21 | 24 | +14.3% |
| RecalcStyleCount | 71 | 62 | -12.7% |
| LayoutDuration | 0.036373 s | 0.044177 s | +21.5% |
| ScriptDuration | 0.210765 s | 0.125580 s | -40.4% |
| TaskDuration | 0.630137 s | 0.464499 s | -26.3% |

The browser sample used Chromium 145 via Playwright 1.58.2 at a fixed 1366×900 viewport after fonts were ready. Layout count and duration remain sample-level residual risks, while long-task, style recalculation, script, and total task measures improved.

## 5. Lifecycle, cleanup, and race verification

- Classroom live-session work is mount-scoped and session-fenced. Timers, listeners, audio, EventSource connections, and active-bubble producers cannot publish after cleanup.
- Workspace owner/session state, navigation, and tab projection are centralized in the mount-scoped owner runtime. Title writes remain serialized and revision-fenced across remounts without changing existing rename semantics.
- Generation Session owns canonical phases and monotonically fenced epochs. Candidate publication occurs only after persistence; failed or superseded sessions revoke/abort before asynchronous cleanup, and terminal intents cannot reopen a failed session.
- Repeated 20-cycle lifecycle checks return listener, timer, audio, signal, and EventSource counts to baseline. The focused cleanup/race suite passed all 63 assertions.
- Strict Mode/remount behavior, stale async completion, rapid stop/start, and terminal-failure cleanup paths are covered by deterministic tests.

## 6. Internal architecture before and after

Before the optimization, high-frequency StageStore changes reached broad playback consumers; classroom transitions were distributed across effects and callbacks; workspace navigation, session ownership, and tab projection were intertwined with the page; generation orchestration and transient resources were distributed through page JSX.

After the optimization:

1. `PlaybackChromeRoot` subscribes only to a stable low-frequency chrome projection, while the existing PlaybackEngine and ChatArea ownership stays in place.
2. Classroom uses canonical transitions and a mount-scoped live runtime, with Chrome, Stage, Interaction, and Control render islands isolated at public seams.
3. Workspace has one owner/session runtime and canonical navigation/tab projection, isolating Rail, Chat, and Classroom rendering without moving hosted/edit lifecycle ownership.
4. Generation uses a canonical session phase and epoch contract behind a controller boundary. Persistence, publication, revocation, and recoverable resource transfer are ordered outside page JSX.
5. Performance specifications execute in dedicated processes without removing or weakening default behavioral coverage.

No runtime singleton was created at module scope. Ownership transfer is explicit, one-way, and idempotently cleaned up.

## 7. Visual, DOM, accessibility, and protocol equivalence

The dedicated no-update suite passed all 41 golden assertions across light/dark modes and 800, 1024, 1366, and 1600 px responsive widths. The full Docker E2E suite passed 82/82. No production DOM hierarchy, CSS, visual token, ARIA contract, route, server interface, storage protocol, or responsive breakpoint was intentionally changed.

The only user-facing behavioral correction found by the release gate restores keyboard focus to the exact launcher after Settings closes. It covers both the permanently mounted Settings trigger and the nested Media Popover trigger; Escape, keyboard launch, and persisted settings all pass. The implementation transfers an existing element reference through owner boundaries and does not add or move rendered elements.

## 8. Deterministic environment diagnostics

Two gate interruptions were reproduced and isolated as environment-only:

- The desktop runtime had drifted from pinned Node.js 22.19.0 to Node.js 24.19.0. A structured-clone Map/BigInt storage test failed under Node 24 and passed unchanged under the Phase 0 runtime. The complete final gate therefore used Node 22.19.0.
- An interrupted conversation left the existing application and PostgreSQL containers stopped. The resulting Editor golden failures were traced to `EAI_AGAIN openmaic-main-postgres-1` and HTTP 500 from `/api/agent/sessions`. Restarting the original containers restored the endpoint to HTTP 200; the unchanged full E2E and golden suites then passed.

Neither incident required a product-code change or a looser gate.

## 9. Residual risks and rollback boundaries

- Performance durations are host-sensitive. Classroom profiler p95 and browser layout duration were higher in the final sample despite reduced render propagation; commit counts, long tasks, script duration, and total task duration improved. Re-sample on the release CI host if it has materially different CPU scheduling.
- The release gate depends on the documented Node.js 22.19.0 toolchain. Node.js 24 behavior should be treated as a separate compatibility investigation, not silently adopted for this release.
- Phase commits are independently reversible at their public seams. Roll back Phase 5 focus changes with `ccfc26e` then `71b78ca`; performance harness changes with `7328025` then `661cfa5`; Generation changes at `640d84a..b9ad2b3`; Workspace changes at `ae639c2..bda2c19`; Classroom changes at `7517b6f..23dab9d`; Playback projection changes at `bf5d1e8..02466f7`. Revert in reverse dependency order and retain each phase's RED contract tests while rolling back.
- Do not roll back individual ownership fences independently of the canonical runtime that they protect. That would re-open stale callback, remount, or resource-publication races.

## 10. Protected worktree verification

`CONTEXT.md`, `.pnpm-store/`, `.scratch/`, and `debug.log` were not staged, overwritten, deleted, or cleaned. `CONTEXT.md` retained its Phase 0 SHA-256 value `8F238F0AF49448DA19882396A1E902008E9816EDDFE500E1EE88831C3983FA43`.
