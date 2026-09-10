# ZHIYU course-generation performance and background-job handoff

## Goal & Scope

Prepare an implementation plan for three related issues in `D:\ZZGG_Innovation_Project\OpenMAIC-main`:

1. Enable bounded parallel scene generation with `PARALLEL_SCENE_CONCURRENCY=2~3`.
2. Make PostgreSQL/persistence configuration explicit and durable in local environment configuration.
3. Move normal frontend course creation from a page-owned browser pipeline to a durable server-side job/worker so generation continues after navigation, tab close, or browser close and can resume/status-render after re-entry.

The next conversation should produce a concrete technical plan first. Do not mutate files, recreate containers, or migrate data until the user approves that plan.

## Diagnosed Current State

- Current working directory: `D:\ZZGG_Innovation_Project\OpenMAIC-main`.
- No production files were changed during diagnosis. `git status --short` showed only existing untracked `.pnpm-store/`, `.scratch/`, and `debug.log`.
- The running app container is `zhiyu`, image `zhiyu:bugfix-20260905`, host port 3000. It has no Docker Compose labels, so treat it as manually created rather than the current Compose `openmaic` service.
- `/api/server-providers` reported `parallelSceneConcurrency: 0`. `PARALLEL_SCENE_CONCURRENCY` was unset in the container.
- The screenshot's fourth scene, `核心工具之三：惯习`, spent 149.15 seconds in `/api/generate/scene-content` before returning successfully. Container CPU was only 0.14%, so local CPU/render saturation was not the cause.
- `deepseek:deepseek-v4-flash` handled the request. Its catalog output window is 393216 and default thinking effort is high. Scene content allows a 300-second route duration.
- The browser continuation pipeline is serial by default. For each pending outline it awaits content, then actions, then optional TTS. Parallel content prewarming is enabled only when `parallelSceneConcurrency > 1`.
- The left spinner is `generatingOutlines[0]`; it remains until the full scene is assembled and added to the store.
- The right interaction panel in the screenshot was collapsed (`width: 0`); its blank appearance is not itself a generation task.

## Problem 1 — Bounded scene concurrency

### Root cause

`lib/server/provider-config.ts:getParallelSceneConcurrency` returns 0 when the environment variable is unset. `lib/hooks/use-scene-generator.ts` therefore uses the original serial loop. Content prewarming, and bounded within-scene TTS concurrency, activate only above 1.

### Proposed solution direction

- Start with `PARALLEL_SCENE_CONCURRENCY=2`; increase to 3 only after verifying the selected LLM and TTS provider quotas do not return 429/rate-limit errors.
- Store the value in the environment source used to recreate the app container. A simple restart does not inject newly added environment variables into an existing container; the app container must be recreated.
- Verify `/api/server-providers` reports the configured value after deployment.
- Measure time-to-first-scene, total generation duration, provider error rate, retries, and token/TTS costs before and after.
- Keep the existing bound/clamp (maximum 10). Do not enable unbounded `Promise.all` fan-out.
- Consider separate concurrency knobs for scene content and TTS in the longer-term plan; reusing one knob couples two provider quotas.

### Primary code pointers

- `lib/server/provider-config.ts:1016`
- `lib/store/settings.ts:937`
- `lib/hooks/use-scene-generator.ts:668`
- `lib/hooks/use-scene-generator.ts:689`
- `lib/hooks/use-scene-generator.ts:753`
- `lib/hooks/use-scene-generator.ts:804`
- `lib/hooks/use-scene-generator.ts:831`
- `lib/media/media-orchestrator.ts:69` (media remains serial by design)

### Acceptance criteria

- Runtime endpoint reports concurrency 2 or 3.
- Later scene-content calls overlap up to the configured bound.
- Actions maintain required ordering/cross-scene speech context.
- No cross-course writes, unbounded fan-out, duplicate billing, or increased 429 failures.

## Problem 2 — PostgreSQL and `.env.local`

### Diagnosed state

- A Docker PostgreSQL container already exists: `openmaic-main-postgres-1`, image `postgres:16`.
- It was stopped cleanly: `Exited (0)` with restart policy `unless-stopped`.
- Existing data volume: `openmaic-main_openmaic-postgres` mounted at `/var/lib/postgresql/data`; preserve it.
- App and PostgreSQL container use the same `openmaic-main_default` network.
- The running app's redacted `DATABASE_URL` host was `openmaic-main-postgres-1:5432`.
- `.env.local` currently had none of these persisted entries: `DATABASE_URL`, `PERSISTENCE_DEV_TOKEN`, `NEXT_PUBLIC_PERSISTENCE`, `NEXT_PUBLIC_PERSISTENCE_TOKEN`, `PERSISTENCE_POSTGRES_PASSWORD`.
- Logs repeatedly showed `getaddrinfo EAI_AGAIN openmaic-main-postgres-1` because only the app container was running.

### Immediate safe recovery

Start and verify the existing database without deleting/reinitializing its volume:

```powershell
docker start openmaic-main-postgres-1
docker exec openmaic-main-postgres-1 pg_isready -U openmaic -d openmaic
docker restart zhiyu
```

Never run `docker compose down -v` against this installation; `-v` would delete the PostgreSQL data volume.

### Proposed durable configuration direction

- Decide on one deployment owner: preferably Compose for both app and PostgreSQL, rather than retaining a manually created `zhiyu` app alongside a Compose database.
- Align the database hostname with the deployment model. Under Compose, prefer the stable service DNS name `postgres`, not a generated container name.
- Put `DATABASE_URL` and `PERSISTENCE_DEV_TOKEN` in `.env.local` for the app runtime. Do not copy any current credentials into notes or chat output.
- `NEXT_PUBLIC_PERSISTENCE=1` and `NEXT_PUBLIC_PERSISTENCE_TOKEN` are build-time settings; switches/values; the public token must match the runtime development token for this trusted local deployment. Rebuild the browser bundle if these values change.
- Confirm how `PERSISTENCE_POSTGRES_PASSWORD` is supplied to Compose interpolation (`.env`, shell environment, or explicit Compose override) and ensure it matches the password with which the existing volume was initialized. Do not assume changing the variable rotates an existing database password.
- Inspect the current redacted connection configuration and existing role/database before recreating anything.

### Primary pointers

- `docker-compose.yml:43`
- `README.md:350`
- `.env.example:347`
- `.env.example:455`

### Acceptance criteria

- PostgreSQL health check passes.
- No recurring PostgreSQL DNS/connection errors in app logs.
- App persistence endpoints initialize successfully after a cold Docker restart.
- Course/session records survive app recreation and host reboot.
- Existing `openmaic-main_openmaic-postgres` data is preserved.

## Problem 3 — Durable background course generation

### Root cause

Normal UI course generation is currently owned by the mounted browser route:

1. `GenerationSessionController` creates the outline/agents/first scene, stores continuation parameters in tab-scoped `sessionStorage`, persists the first scene, and navigates to `/classroom/:id`.
2. The standalone classroom route and hosted `ClassroomSurface` read `generationParams` and invoke `useSceneGenerator.generateRemaining()`.
3. Both owners call `stop()` when the course changes or the component unmounts.
4. `stop()` bumps the generation epoch and aborts the active scene and media fetch controllers. Late results are deliberately discarded to prevent course A writes from landing in course B.

A static automated diagnostic found two page owners calling `stop()`, both scene/media abort paths enabled, and zero frontend call sites for `/api/generate-classroom`.

### Existing but incomplete server path

- `POST /api/generate-classroom` already creates a job and invokes `runClassroomGenerationJob` through Next `after()`.
- Job progress is currently file-backed under `data/classroom-jobs` and the runner is an in-process promise map.
- The normal frontend does not call this endpoint.
- This path can outlive navigation while the app process stays alive, but it is not a robust independent worker: an app/container restart can strand the job, and current generation persists the final classroom rather than exposing every normal frontend lifecycle behavior incrementally.

### Recommended architecture

Create a durable PostgreSQL-backed generation job model and an independently owned worker:

- Persist job identity, owner, stage ID, input snapshot, status, current phase, per-scene progress, retry counters, timestamps, cancellation state, error, and worker lease/heartbeat.
- Use idempotency keys for job creation and per-scene writes.
- Persist the stage/outlines before long-running scene generation so the course can appear immediately in the library as `generating`.
- Persist each completed scene/action/media state transactionally or through an explicit resumable checkpoint.
- Let a dedicated worker claim queued jobs using PostgreSQL locking/leases. Do not rely solely on an in-memory `Map` or `after()`.
- On worker/container restart, expired leases return jobs to a resumable queue instead of marking them permanently stale.
- Frontend course creation submits the job and navigates freely. UI observes status through polling or SSE; re-entering the course reconstructs state from PostgreSQL rather than `sessionStorage`.
- Preserve the existing generation epoch/cancellation protections for local UI state and prevent duplicate browser-side generation. A server-job-owned outline must never also start `useSceneGenerator`.
- Define explicit cancel/retry semantics and cleanup for partially allocated image/audio assets.
- Decide how generated-agent configuration, source/PDF assets, model/thinking settings, web-search settings, and provider selection are snapshotted without persisting raw client secrets in the job payload. Prefer server-managed provider credentials; never store API keys in job rows.
- Add job-level and scene-level timeouts, structured progress timing, and bounded concurrency.

### Primary code pointers

- `app/generation-preview/GenerationSessionController.tsx:1090`
- `app/classroom/[id]/page.tsx:148`
- `app/classroom/[id]/page.tsx:174`
- `components/classroom/ClassroomSurface.tsx:222`
- `components/classroom/ClassroomSurface.tsx:272`
- `lib/hooks/use-scene-generator.ts:619`
- `lib/hooks/use-scene-generator.ts:904`
- `app/api/generate-classroom/route.ts:14`
- `app/api/generate-classroom/route.ts:48`
- `lib/server/classroom-job-runner.ts`
- `lib/server/classroom-job-store.ts`
- `lib/server/classroom-generation.ts`
- `components/classroom/ClassroomSurface.tsx:251` (`outlineProducer === 'server-job'` guard)

### Required test/verification plan

- Create course, navigate Home immediately, and verify generation continues.
- Close the browser and verify the worker continues.
- Restart only the app container mid-scene and verify the job resumes safely.
- Open the same course in two tabs and verify only one producer writes.
- Retry provider 429/5xx/timeout failures without duplicate scenes or double asset ownership.
- Cancel a job and verify no later result commits.
- Verify incremental progress and completed scenes after re-entry.
- Verify existing completed courses and browser-local courses remain readable/migratable.
- Verify no credential material is stored in PostgreSQL job rows or emitted in logs.

## Decisions and Constraints

- PostgreSQL should run in Docker; no native Windows PostgreSQL installation is required.
- Preserve the existing PostgreSQL volume and current course data.
- Use bounded concurrency, beginning conservatively at 2.
- The desired result is true background generation, not merely lifting the hook to a higher React component. A global browser owner would still stop when the browser closes.
- Current abort/epoch fencing exists for correctness and must be replaced with equivalent job ownership/idempotency, not simply removed.
- Keep provider credentials out of handoff documents, database job payloads, and logs.

## Suggested Skills

1. `matt-skills-curated:diagnosing-bugs` — revalidate the live deployment state before planning mutations.
2. `matt-skills-curated:codebase-design` — define the job/worker boundary and ownership seams.
3. `matt-skills-curated:to-spec` — turn the agreed architecture into a buildable specification.
4. `matt-skills-curated:to-tickets` — decompose the approved spec into dependency-ordered work.
5. `matt-skills-curated:implement-spec` only after the user approves the spec and explicitly requests implementation.

## Exact Next Action

In a fresh conversation rooted at `D:\ZZGG_Innovation_Project\OpenMAIC-main`, attach/read this handoff and use this prompt:
