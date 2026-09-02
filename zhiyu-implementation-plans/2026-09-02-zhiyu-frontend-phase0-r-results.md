# Zhiyu frontend Phase 0-R results

Date: 2026-09-02 (Asia/Shanghai)

Status: **READY FOR PHASE 1**.

Scope: Phase 0-R only. Phase 1 was not started. No visual-presentation, DOM-markup, CSS, ARIA, route, backend-protocol, or Docker-topology change was made. This Performance Closure added test harnesses, verification configuration, and evidence only; it changed no product code. Earlier Phase 0-R playback corrections remain covered by their independent RED-GREEN commits.

## Dirty-worktree protection

The pre-existing dirty worktree was treated as user-owned. The two implementation-source documents explicitly requested by the user were staged and committed separately; every other protected path, including `CONTEXT.md` and `.scratch/`, was left unstaged and was not reset, deleted, or overwritten.

| Path | Final state | SHA-256 where practical |
| --- | --- | --- |
| `CONTEXT.md` | modified, unstaged | `8F238F0AF49448DA19882396A1E902008E9816EDDFE500E1EE88831C3983FA43` |
| `zhiyu-implementation-plans/2026-09-01-07-zhiyu-frontend-internal-architecture-optimization.md` | tracked in its own commit `307ebe2` | `BA80221319C2B0D2978F3C35F5A48609A653131680939D86DFF54431C2A7C84E` |
| `zhiyu-implementation-plans/2026-09-02-zhiyu-frontend-phase0-baseline.md` | tracked in its own commit `ad11982` | `206BF2D4B813B0E7FF99869198044A97E6044671AFCA3287C5D8787DCF2642BC` |
| `.pnpm-store/`, `.scratch/`, `debug.log` | untracked | preserved; not separately hashed or staged |

The Phase 0 verification contract fingerprints dirty-file contents, not only porcelain status.

## Pinned verification environment

- Host verification Node: `v22.19.0`, invoked by absolute executable path.
- pnpm CLI: `10.28.0`, invoked through the pinned Corepack payload when needed.
- Vitest: `4.1.8`, invoked by the fixed Node executable.
- Playwright: `1.58.2`.
- Docker builder: `node:22-alpine` plus `corepack prepare pnpm@10.28.0 --activate`.
- Verification entry point: `node scripts/phase0-verify.mjs critical`.

The final critical verification built image `openmaic-phase0-verify:builder` (`sha256:b05aa2885e622545b8383d17c60bcd5adfc07c670d25d1c23293e982d9a99356`) and exited 0.

## Final gates

| Gate | Result |
| --- | --- |
| Production Docker build | PASS; Next.js production build completed, TypeScript passed, 52/52 static pages generated |
| Critical Vitest set inside builder | PASS; 10 files, 110/110 tests |
| Full host Vitest, fixed Node 22.19 | PASS; default suite: 661 passed files, 10 skipped files; 7160 passed tests, 44 skipped tests; 0 failures; 92.29s. Dedicated real-Workspace benchmark: 1 file, 1/1 test; 20.89s |
| Full production E2E | PASS; 80/80, 2 workers, retries 0, about 1.3 minutes |
| Responsive visual suite on Win32 | PASS; 41/41 |
| Responsive visual suite on official Playwright Noble Linux runner | PASS; update 41/41, then no-update 41/41, retries 0 |
| Golden inventory | 41 Win32 PNGs and 41 Linux PNGs; one-to-one names; valid PNGs; Win32 hashes preserved; no exact cross-platform copies |
| Docker port 3000 | PASS; `http://127.0.0.1:3000/api/health` returned 200 |
| Real Workspace integration Profiler | PASS; real Shell/Rail/Chat/Classroom mounted; fixed 300-event stress sequence recorded |
| Production-browser performance | PASS; fixed Docker/Chromium/font/viewport fixture; no real provider requests; long-task and CDP metrics recorded |

The final E2E run did not update snapshots or modify tracked or protected files. Ignored Playwright result/report artifacts may be rewritten by a run.

Existing webpack warnings for expression-based optional imports, `pg-native`, and optional Sharp platform packages remained warnings; the production build exited 0.

## Docker runtime contract

The production-baseline container was replaced under the same name and topology. The current `openmaic-phase0-e2e` uses image `openmaic:phase0` (`sha256:b11519361acd0ec3e2ce26f0f0178bc9b686cd3a0342d5ea4814a491164a3825`) and is `running`.

- Port: `3000/tcp` published to host port `3000` on IPv4 and IPv6.
- Network: `openmaic-main_default`.
- Mounts: none.
- Restart policy: `no`.
- Required flags: `NEXT_PUBLIC_PRO_WORKBENCH_ENABLED=true`, `OPENMAIC_AGENT_RUNTIME_ENABLED=true`.
- Database endpoint: existing `openmaic-main-postgres-1:5432/openmaic` on the same network.

No Docker topology change was introduced.

## RED-GREEN issue ledger

Each behavior or determinism issue was isolated, reproduced or captured as a failing regression, fixed without broadening timeouts, handled through the subagent review workflow, and committed separately. Baseline-only additions were also kept in independent commits. Git proves the commit separation; the review evidence belongs to this task's execution record.

| Commit | Regression or baseline |
| --- | --- |
| `e5ac76b` | pin Phase 0 runtime and critical suite |
| `dd97120` | disambiguate drawer and dismiss labels in tests |
| `2524cd2` | normalize Windows skill-loader paths |
| `3605e70` | make the bash-only CI contract explicitly skip without bash |
| `68cfbc4` | normalize media-ownership guard paths |
| `c030a7c` | complete the reduced-motion mock |
| `c76fa87` | write portable ZIP entry paths |
| `0a091b3` | assert native classroom paths deterministically |
| `129a316` | assert native image paths deterministically |
| `d38b2d7` | isolate persistence recovery timers |
| `24fc6e1` | move the rail import outside the timed test body |
| `c1848c0` | seed the persistent outline-review fixture |
| `5482c05` | target exact playback controls |
| `3d6ed69` | assert the hosted workspace editor path |
| `9461eb9` | follow the hosted editor route |
| `5b1c627` | scope iframe keepalive to the hosted editor lifecycle |
| `cb7eaa0` | follow hosted quiz playback |
| `bae3373` | gate the generation-shell SSE lifecycle |
| `bf63e20` | target the exact playback cursor control |
| `5fa51b3` | queue Play until the playback engine is ready |
| `efeb514` | add the Zhiyu visual golden matrix |
| `ebced12` | release the owned end-flash timer |
| `725f8e8` | add the synthetic playback Profiler seam baseline |
| `01e0659` | cancel stale auto-advance work |
| `a9d806f` | baseline OwnerSessionClient cleanup |
| `73f94dd` | baseline playback listener and audio cleanup |
| `5110c54` | isolate workspace owner fixtures |
| `ed6af73` | add Linux visual goldens |
| `2b4a7ea` | isolate call-agent child mocks |
| `760876a` | control classroom generation-retry timing |
| `b1afdb9` | stabilize route cue-user imports |
| `a3d3e55` | bound legacy-import scan reads |
| `dea37fe` | precollect the asset-URL scan corpus |
| `7d23335` | precollect the video-resolution corpus |
| `3f26dc9` | warm the LLM-entry lint guard before timed cases |
| `3bc0e04` | stabilize extract-document route imports |
| `2605852` | warm the video-export ESLint boundary before timed cases |
| `307ebe2` | preserve the architecture implementation plan as an isolated source-of-truth commit |
| `ad11982` | preserve the initial Phase 0 baseline as an isolated source-of-truth commit |
| `09976cf` | add the fixed production Workspace browser-performance harness |
| `515e883` | add the real Workspace integration Profiler harness |
| `e91e644` | isolate the resource-heavy Workspace benchmark from the default parallel Vitest pool |
| `b14766b` | isolate the material character-budget regression from host-clock contention |
| `b5718bc` | move scene-generator retry wrapper imports outside timed test cases |

The Performance Closure exposed two additional deterministic test problems. The material character-budget case used a real 100ms deadline, so suite-wide CPU contention could stop the scan before its character limit; its RED was captured with a controlled clock and GREEN keeps the real delayed reader while proving the character-budget behavior. The scene-generator retry case paid a roughly 2.3s first module-transform cost inside a 2s timed case; the RED used the tighter 2s gate and GREEN statically imports the same cached public exports before case timing. Each fix is test-only, independently reviewed, and independently committed without widening a timeout.

## Visual baseline

The responsive golden matrix covers the agreed Home, Generation, Classroom, Workspace, hosted editor, Settings, Editor, Conversation, and related responsive/focus states. The broader production E2E suite separately covers quiz playback, cursor, drawer, and hosted lifecycle paths. The final production E2E and no-update runs demonstrate that the checked-in goldens are stable in both the fixed Win32 environment and the official Playwright Noble Linux browser/font stack.

Local Linux output is still not proof of byte-identical rendering on GitHub's moving `ubuntu-latest` image; CI remains the authoritative environment-specific confirmation.

## Real Workspace integration Profiler baseline

Harness: `tests/performance/zhiyu-workspace-profiler-baseline.test.ts`. It mounts the real `WorkspaceShell`, `WorkspaceRail`, `WorkspaceChatPane`, and `WorkspaceClassroomPane`, including the real Workbench chat, editor/classroom surface, Zustand stores, `OwnerSessionClient`, and `useWorkbenchStream`. Only external boundaries are mocked: the Next navigation adapter, stage persistence, `fetch`, `EventSource`, IndexedDB, and browser observers/scheduling. No empty pane or nonresponsive store is used.

The fixed stress fixture injects 100 iterations of `owner.session_status`, `session.message_update`, and `session.tool_execution_end(generate_tts)` for session `phase0-session`, course `phase0-course`, and scene `phase0-scene`. This is a repeatable stress sequence, not a claim about production event frequency or browser timing.

Environment: Node `v22.19.0`; React/ReactDOM `19.2.3`; Win32 x64; Vitest jsdom development React; StrictMode off; synthetic viewport 1366.

| Real island | Commits | p50 (ms) | p95 (ms) | max (ms) |
| --- | ---: | ---: | ---: | ---: |
| WorkspaceRail | 100 | 3.247 | 12.062 | 13.539 |
| WorkspaceChatPane | 700 | 0.533 | 3.342 | 21.654 |
| WorkspaceClassroomPane | 300 | 0.057 | 12.903 | 22.650 |

Raw report command:

```powershell
$env:PHASE0_PROFILER_REPORT='1'
& 'C:\Users\Lenovo\AppData\Local\Temp\openmaic-phase0-node-v22.19.0\node-v22.19.0-win-x64\node.exe' 'node_modules\.pnpm\vitest@4.1.8_@opentelemetry_e490a866f0ee1b5df6b8350abbd23dc0\node_modules\vitest\vitest.mjs' run --config vitest.workspace-performance.config.ts --reporter=verbose
```

## Production-browser performance baseline

Harness: `e2e/performance/zhiyu-production-performance.spec.ts`, configured by `playwright.performance.config.ts`. It runs against the unchanged `openmaic-phase0-e2e` production container and a fixed local stage fixture. Provider, owner/session, freshness, manifest, and scene network boundaries are deterministic; real provider requests and unexpected external requests are asserted to remain zero. A `PerformanceObserver` is installed before navigation, `document.fonts.ready` is awaited, and Chrome DevTools Protocol performance counters are captured after a fixed 1000ms observation window.

Environment: Playwright `1.58.2`; Chromium `145.0.7632.6`; Win32; viewport 1366x900; device scale factor 1; locale `en-US`; timezone UTC; light scheme; `Inter Variable` loaded and `document.fonts.ready=true`; Docker image `openmaic:phase0` at `sha256:b11519361acd0ec3e2ce26f0f0178bc9b686cd3a0342d5ea4814a491164a3825`.

Final raw sample:

| Metric | Value |
| --- | ---: |
| Long-task count | 2 |
| Long-task total duration | 216 ms |
| Long-task maximum duration | 161 ms |
| Long-task durations | 161 ms, 55 ms |
| LayoutCount | 21 |
| RecalcStyleCount | 71 |
| LayoutDuration | 0.036373 s |
| ScriptDuration | 0.210765 s |
| TaskDuration | 0.630137 s |

Three earlier same-environment closure samples recorded long-task count 1 with 142-150ms total duration, LayoutCount 22-23, RecalcStyleCount 60-62, LayoutDuration 0.036434-0.042120s, ScriptDuration 0.127984-0.156817s, and TaskDuration 0.455560-0.500699s. These raw samples are comparison evidence, not budgets.

Command:

```powershell
& 'C:\Users\Lenovo\AppData\Local\Temp\openmaic-phase0-node-v22.19.0\node-v22.19.0-win-x64\node.exe' 'node_modules\@playwright\test\cli.js' test --config=playwright.performance.config.ts --workers=1 --retries=0
```

## Synthetic component-seam Profiler baseline

Baseline kind: `synthetic-component-seam`. Each scenario records 100 independent commits in one identical harness. These numbers are relative comparison baselines, not browser frame, layout, paint, font, or long-task measurements.

| Component | Speech p95 (ms) | Thinking p95 (ms) |
| --- | ---: | ---: |
| PlaybackChromeRoot | 5.643 | 2.165 |
| ClassroomShell | 3.684 | 1.532 |
| Header | 0.650 | 0.410 |
| SceneRail | 1.201 | 0.565 |
| InteractionPanel | 1.353 | 0.404 |
| PlaybackBar | 0.071 | 0.021 |

Child subtrees excluded by the harness are explicitly declared in the Profiler fixture. Profiler tests pass 3/3 under the fixed Node runtime.

## Lifecycle and cleanup baseline

- End-flash timer: the RED retained 20 timers after 20 mount/unmount cycles; GREEN releases the component-owned timer.
- Auto-advance: cancels pending teardown work, stale stage work, and scene ABA work.
- `OwnerSessionClient`, 20 cycles: active delta while mounted is two owned timers (one interval and one timeout); post-unmount delta is zero. Timeout set/clear is 20/20, interval set/clear is 20/20, EventSource create/close/live is 20/20/0.
- Playback, 20 cycles: mounted window listeners are `keydown` x2 plus `mousemove`, `mousedown`, and `touchstart` x1; document `fullscreenchange` x1; media-query `change` x2. All return to zero with matching listener identities after unmount. Both retained audio players are destroyed exactly once in all 20/20 cycles.

## Reproduction commands

```powershell
& 'C:\Users\Lenovo\AppData\Local\Temp\openmaic-phase0-node-v22.19.0\node-v22.19.0-win-x64\node.exe' scripts/phase0-verify.mjs critical
& 'C:\Users\Lenovo\AppData\Local\Temp\openmaic-phase0-node-v22.19.0\node-v22.19.0-win-x64\node.exe' 'node_modules\.pnpm\vitest@4.1.8_@opentelemetry_e490a866f0ee1b5df6b8350abbd23dc0\node_modules\vitest\vitest.mjs' run --config vitest.config.ts --reporter=dot --silent=passed-only
& 'C:\Users\Lenovo\AppData\Local\Temp\openmaic-phase0-node-v22.19.0\node-v22.19.0-win-x64\node.exe' 'node_modules\.pnpm\vitest@4.1.8_@opentelemetry_e490a866f0ee1b5df6b8350abbd23dc0\node_modules\vitest\vitest.mjs' run --config vitest.workspace-performance.config.ts --reporter=verbose
& 'C:\Users\Lenovo\AppData\Local\Temp\openmaic-phase0-node-v22.19.0\node-v22.19.0-win-x64\node.exe' 'node_modules\@playwright\test\cli.js' test --config=playwright.docker.config.ts --workers=2 --retries=0
& 'C:\Users\Lenovo\AppData\Local\Temp\openmaic-phase0-node-v22.19.0\node-v22.19.0-win-x64\node.exe' 'node_modules\@playwright\test\cli.js' test e2e/tests/zhiyu-responsive-matrix.spec.ts --config=playwright.docker.config.ts --workers=1 --retries=0
```

The resource-heavy real-Workspace benchmark is intentionally excluded by exact path from the default parallel Vitest pool and is a mandatory second Vitest gate through `vitest.workspace-performance.config.ts`. “Full Vitest” in this baseline means both commands pass: 7204 collected default-suite tests plus the 1/1 dedicated Workspace integration benchmark.

## Remaining limits, not blockers

1. React Profiler durations come from development React under jsdom; the browser baseline separately measures production-bundle browser work. Neither should be substituted for the other.
2. The Workspace event stream is a fixed stress sequence; it establishes repeatable relative baselines, not production traffic frequency or service-level budgets.
3. Linux goldens were validated with Playwright 1.58.2's official Noble runner. Only the actual CI runner can prove that a future CI image and fonts remain equivalent.

The two performance exit blockers recorded previously are now closed with truthful, independently reviewed harnesses. All mandatory local Phase 0-R gates are green, so the repository is **READY FOR PHASE 1**. There is no remaining local Phase 0 blocker; the Linux CI note is an environment-specific future confirmation dependency, not a current RED.
