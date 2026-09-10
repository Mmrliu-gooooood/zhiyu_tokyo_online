# Generation progress, Home role preferences, and topic cards

Date: 2026-09-05

Base: `411473d7a729a30e154bf8c31bc5af802f7d9e52`

## Scope and architecture

This is a focused follow-up to the completed frontend architecture work, not another execution of Phases 0–5.

- The generation timeline consumes the existing canonical phase. The foreground pipeline generates the first scene before handing off to Classroom; published scene counts cannot tell when its content has entered action generation. The completed content step no longer shows a misleading `0 / total` count while actions are running.
- Both existing Classroom owners (the standalone route and Workspace's `ClassroomSurface`) retain their own loading effects. Each saves the incoming Home role mode, selected IDs, and selection provenance, then restores those three fields atomically on cleanup. Manual retries capture that visit's cancellation check, preventing late loads from overwriting the restored choice.
- A presentation-only topic component shows four outline titles per card, rotates every five seconds, includes the final partial card, and wraps. It provides manual paging and pause/resume; reduced-motion users start paused. The component owns and releases its own interval. Outline review remains static and clickable.

No route, API, storage key/schema, dependency, Dockerfile, Compose file, canonical runtime, PlaybackEngine, ChatArea, EventSource, or audio ownership was changed. The requested topic-preview controls are the intentional UI addition.

## RED / GREEN evidence

| Boundary | RED observation | GREEN coverage |
| --- | --- | --- |
| Generation projection | Actions pending, content active with zero published scenes, despite canonical `media-actions` | Actions active, content done; action-failure projection covered |
| Topic component | After five seconds only the first four titles remained | Four-title groups, final partial group, wrap, pause/manual control, prop changes, Strict Mode and interval cleanup |
| Home/classroom | Preset → auto → existing preset course → Home overwrote the auto choice with course defaults | Both real public Classroom entries, default auto, explicit preset/auto, generated rosters, repeated visits, Strict Mode, delayed load and retry after unmount |
| Browser route integration | Initial hosted-only fix still failed the standalone Home roundtrip | Standalone route was added to the same regression contract without merging the two owners |

The ordinary valid preset fixture already retained its selection before the fix. The browser regression now explicitly replaces Class Clown with Curious Mind, verifies the returned checkbox state, then switches to auto and repeats the visit. It does not claim that every possible pre-existing roster corruption was reproduced.

## Verification

| Check | Result |
| --- | --- |
| Final Vitest, pinned Node 22.19.0, four workers | 671 files passed, 10 skipped; 7274 tests passed, 45 skipped; no failures |
| Local production build | Passed, including production TypeScript and 52 routes |
| Final Docker build | Passed, 52 routes; `zhiyu:bugfix-20260905` and `zhiyu:latest` |
| Full Docker Playwright | 87/87 passed, two workers, zero retries, 1.7 minutes |
| Existing responsive/golden cases | 41/41 passed within the full Docker run; no baseline updates |
| ESLint | Zero errors; 18 pre-existing warnings; changed production/test files clean |
| i18n alignment | 12 locales passed |
| Standalone + Hosted role lifecycle | 16 tests passed, including retry cancellation |
| Independent review | Standards and Spec passed |

Logs are under the ignored `logs/zhiyu-bugfix-20260905/` directory. Successful second-card screenshots were captured for both agent and content generation. Browser rotation tests use native time so Motion's document timeline and timer time agree; component tests retain fake-clock assertions for exact five-second timing and cleanup.

## Local deployment and commits

- Running container: `zhiyu`, host port 3000, restart policy `unless-stopped`.
- Image: `sha256:860afecfae0f2c4222ca6bfd2538e516f95c6615fe08ae0befa52e0a7f3cfa46`.
- Original environment, `openmaic-main_default` network, and `openmaic-main_openmaic-data:/app/data` volume retained. PostgreSQL was not replaced. Final `/api/health` returned HTTP 200.
- Previous container is retained stopped as `zhiyu-before-bugfix-20260905`; its image is tagged `zhiyu:before-bugfix-20260905` for rollback. The temporary local port-3002 verification server was stopped.

| Commit | Change |
| --- | --- |
| `14acb2b` | Preserve Home role preferences at both existing Classroom owners and fence manual retries |
| `c56487c` | Align the generation timeline with canonical phases and rotate topic preview cards |

## Review and existing limitations

- Independent Standards and Spec reviews passed after fixing the retry cancellation gap and covering the actual standalone route.
- Unrestricted parallel Vitest initially timed out in three unchanged Pi server integration files, with one dependent late-result assertion. Those 52 tests passed unchanged in a dedicated single-worker run; the complete four-worker suite then passed without increasing timeouts or retries.
- The repository-wide `tsc --noEmit --incremental false` reported three existing fixture type errors in `tests/classroom/playback-chrome-stage-projection.test.ts` (lines 28, 29, 67). That file and the relevant Stage/Scene type definitions were not changed. Production builds use the existing `tsconfig.build.json` and validate production TypeScript separately.
- Protected `CONTEXT.md`, `.pnpm-store/`, `.scratch/`, and `debug.log` remain unstaged. `CONTEXT.md` SHA-256 remains `8F238F0AF49448DA19882396A1E902008E9816EDDFE500E1EE88831C3983FA43`.
