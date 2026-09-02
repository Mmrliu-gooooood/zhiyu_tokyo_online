# Zhiyu frontend Phase 0-R results

Date: 2026-09-02 (Asia/Shanghai)

Scope: Phase 0-R only. Phase 1 was not started. No visual-presentation, DOM-markup, CSS, ARIA, route, backend-protocol, or Docker-topology change was made. Two playback interaction defects were corrected under RED-GREEN coverage: an early Play request is queued until the engine is ready, and stale auto-advance work is cancelled.

## Dirty-worktree protection

The pre-existing dirty worktree was treated as user-owned. No protected path was staged, reset, deleted, or overwritten.

| Path | Final state | SHA-256 where practical |
| --- | --- | --- |
| `CONTEXT.md` | modified, unstaged | `8F238F0AF49448DA19882396A1E902008E9816EDDFE500E1EE88831C3983FA43` |
| `zhiyu-implementation-plans/2026-09-01-07-zhiyu-frontend-internal-architecture-optimization.md` | untracked | `14AFC13257A1D7DDF2762297D7A27DCC99B74A1E3BA35AAE90DB56C9CFBF314C` |
| `zhiyu-implementation-plans/2026-09-02-zhiyu-frontend-phase0-baseline.md` | untracked | `206BF2D4B813B0E7FF99869198044A97E6044671AFCA3287C5D8787DCF2642BC` |
| `.pnpm-store/`, `.scratch/`, `debug.log` | untracked | preserved; not separately hashed or staged |

The Phase 0 verification contract fingerprints dirty-file contents, not only porcelain status.

## Pinned verification environment

- Host verification Node: `v22.19.0`, invoked by absolute executable path.
- pnpm CLI: `10.28.0`, invoked through the pinned Corepack payload when needed.
- Vitest: `4.1.8`, invoked by the fixed Node executable.
- Playwright: `1.58.2`.
- Docker builder: `node:22-alpine` plus `corepack prepare pnpm@10.28.0 --activate`.
- Verification entry point: `node scripts/phase0-verify.mjs critical`.

The final critical verification built image `openmaic-phase0-verify:builder` (`sha256:436d0426eb0eb6f7506119e473958bd2f43739e8e07590271ebe4b47250fb1f1`) and exited 0.

## Final gates

| Gate | Result |
| --- | --- |
| Production Docker build | PASS; Next.js production build completed, TypeScript passed, 52/52 static pages generated |
| Critical Vitest set inside builder | PASS; 10 files, 110/110 tests |
| Full host Vitest, fixed Node 22.19 | PASS; 661 passed files, 10 skipped files; 7160 passed tests, 44 skipped tests; 0 failures; 93.09s |
| Full production E2E | PASS; 80/80, 2 workers, retries 0, about 1.3 minutes |
| Responsive visual suite on Win32 | PASS; 41/41 |
| Responsive visual suite on official Playwright Noble Linux runner | PASS; update 41/41, then no-update 41/41, retries 0 |
| Golden inventory | 41 Win32 PNGs and 41 Linux PNGs; one-to-one names; valid PNGs; Win32 hashes preserved; no exact cross-platform copies |
| Docker port 3000 | PASS; `http://127.0.0.1:3000/` returned 200 with 32,466 response bytes |

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

The last full-suite RED before green was `tests/video-export/eslint-boundary.test.ts`: the first real ESLint probe took 7,338ms under full load and exceeded the unchanged 5,000ms limit. The same ESLint instance is now fail-fast warmed during module collection. The isolated file passes 8/8 with the first timed probe at 19ms; the final full suite is green.

## Visual baseline

The responsive golden matrix covers the agreed Home, Generation, Classroom, Workspace, hosted editor, Settings, Editor, Conversation, and related responsive/focus states. The broader production E2E suite separately covers quiz playback, cursor, drawer, and hosted lifecycle paths. The final production E2E and no-update runs demonstrate that the checked-in goldens are stable in both the fixed Win32 environment and the official Playwright Noble Linux browser/font stack.

Local Linux output is still not proof of byte-identical rendering on GitHub's moving `ubuntu-latest` image; CI remains the authoritative environment-specific confirmation.

## Profiler baseline

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

## True blockers and limits

1. Production-browser performance is not yet measured. The production React bundle does not expose Profiler timings, so browser layout, paint, font work, and long tasks remain outside this Phase 0-R baseline.
2. A truthful full Workspace owner/session Profiler baseline is still unavailable. The existing workspace harness replaces the relevant store and Rail/Chat/Classroom panes with nonresponsive or empty mocks; reporting those timings as a product baseline would be fabricated.
3. Linux goldens were validated with Playwright 1.58.2's official Noble runner. Only the actual CI runner can prove the repository's current CI image and fonts remain equivalent over time.

Items 1 and 2 are real Phase 0 exit blockers under the architecture plan's Task 0.4 and exit conditions. Phase 0-R is therefore **BLOCKED at the performance-baseline exit gate**, despite the green build, unit, critical, E2E, golden, and cleanup gates. Phase 1 must not start until truthful production-browser and full Workspace owner/session profiling evidence is available. Item 3 is an environment-specific CI confirmation dependency rather than a current local RED.
