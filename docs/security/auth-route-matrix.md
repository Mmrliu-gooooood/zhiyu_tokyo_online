# Auth route matrix (P0)

Generated from the 2026-09-19 worktree. Dual-mode: `AUTH_MODE=supabase` requires a verified principal; unset keeps legacy anonymous / access-code / `PERSISTENCE_DEV_TOKEN` behavior so teach-back, classroom, and generation stay intact.

This table is **code classification**, not a live 401 run. Hosted fail-closed JSON 401s are implemented in gates below; they were not exercised against a real Supabase project.

Auth UI pages (not `route.ts`): `/auth/login`, `/auth/sign-up`, `/auth/check-email`, `/auth/forgot-password`, `/auth/update-password`, `/auth/error`, `/account`, `/admin`.

Sharing: hosted publish returns `SHARING_DISABLED`; `is_public` is not a read grant.

Counted `app/api/**/route.ts`: **88**. Plus `/auth/confirm`.

| Route | Methods | Hosted auth | Owner object | Legacy (AUTH_MODE unset) | Notes / tests |
| --- | --- | --- | --- | --- | --- |
| `/auth/confirm` | GET | `token_hash` + `verifyOtp`; fail-closed without hosted config | session cookies | redirects to error | `app/auth/confirm/route.ts`; `safeNextPath` |
| `/api/access-code/status` | GET | always `{ enabled: false }` | none | access-code cookie | not a second identity |
| `/api/access-code/verify` | POST | rejected / unused as identity | none | issues access cookie | |
| `/api/admin/status` | GET | `requirePrincipal` + `requireAdmin` | none (counts only) | 401 hosted-not-enabled | no course contents |
| `/api/agent/media-config-snapshots` | POST, DELETE | `withRequestOwnerId` → `requirePrincipal` | snapshot owner | signed `generation_owner` cookie | Pro/runtime gate |
| `/api/agent/model-connections` | POST, DELETE | `withRequestOwnerId` | connection owner | signed cookie | Pro-gated |
| `/api/agent/owner-events` | GET | `withRequestOwnerId`; poll re-checks `tryPrincipal` every 30s | owner event log | signed cookie | SSE |
| `/api/agent/runtime` | GET | none (capability flags only) | none | same | no user data |
| `/api/agent/runtime` | POST | `withRequestOwnerId` | owner model preflight | signed cookie | Pro-gated |
| `/api/agent/sessions` | GET, POST | `withRequestOwnerId`; POST `refuseForeignStagePost` when `stageId` is present (`requireExisting` for existingCourse) | session + stage | signed cookie | foreign/missing existing-course 404 |
| `/api/agent/sessions/[id]` | GET, PATCH | `withRequestOwnerId`; foreign id 404 | session | signed cookie | |
| `/api/agent/sessions/[id]/cancel` | POST | `withRequestOwnerId` | session | signed cookie | |
| `/api/agent/sessions/[id]/events` | GET | `withRequestOwnerId`; poll re-checks `tryPrincipal` every 5s | session | signed cookie | SSE |
| `/api/agent/sessions/[id]/messages` | POST | `withRequestOwnerId` | session | signed cookie | |
| `/api/agent/sessions/status` | GET | `withRequestOwnerId` | owner sessions | signed cookie | |
| `/api/agent/skills` | GET, POST | `withRequestOwnerId` | user skills | signed cookie | Pro-gated |
| `/api/agent/skills/[id]` | GET, DELETE | builtin zip public; user skill via `withRequestOwnerId` | user skill | signed cookie | builtin/openmaic zip has no owner |
| `/api/auth/me` | GET | `requirePrincipal` | self | 401 hosted-not-enabled | private, no-store |
| `/api/auth/profile` | PATCH | `requirePrincipal` + origin | `app_profiles` | 401 hosted-not-enabled | display name only |
| `/api/auth/resend` | POST | origin + rate limit; no session | email (signup resend) | 401 hosted-not-enabled | generic success; no enumeration |
| `/api/auth/sign-out` | POST | origin + revoke session | current session | 401 hosted-not-enabled | CSRF origin |
| `/api/azure-voices` | POST | `hostedAuthGate` | none | unchanged | no platform secrets |
| `/api/chat` | POST | `hostedAuthGate` + `refuseForeignStagePost` on `storeState.stage.id` | stage | unsigned `anon:` library still allowed; signed-in foreign/shared 404 | gate only; protocol unchanged |
| `/api/chat/pi` | POST | `hostedAuthGate` + `refuseForeignStagePost` on `storeState.stage.id` | stage | same as `/api/chat` | gate only |
| `/api/chat/pi/whiteboard-visibility` | POST | `hostedAuthGate` | stage/session if present | unchanged | |
| `/api/classroom` | GET, POST | `requirePrincipalIfHosted`; snapshot `ownerId` | classroom JSON | no owner field required | no cross-user overwrite |
| `/api/classroom-media/[classroomId]/[...path]` | GET | `requirePrincipalIfHosted` + classroom owner | file | public cache | hosted `private, no-store`; Range on GET |
| `/api/comfyui-workflows` | GET | `hostedAuthGate` | none | unchanged | |
| `/api/export-video/capability` | GET | `hostedAuthGate` | none | unchanged | |
| `/api/export-video/render` | POST | `requirePrincipalIfHosted` | `render-job-owners` | no owner map required | |
| `/api/export-video/render/[jobId]` | GET, DELETE | `requirePrincipalIfHosted` + job owner | render job | no owner map required | foreign → 404 |
| `/api/export-video/render/[jobId]/download` | GET | `requirePrincipalIfHosted` + job owner | render job | no owner map required | foreign → 404 |
| `/api/extract-document` | POST | `runIndependentHeavyTaskRequest` (hosted cannot skip identity) | owner lease | may skip lease without DB | |
| `/api/folders` | GET, POST | `withRequestOwnerId` + cloud library gate | folder | signed cookie / anon | `isCloudCourseLibraryEnabled` |
| `/api/folders/[id]` | PATCH, DELETE | `withRequestOwnerId` + library gate | folder | signed cookie / anon | |
| `/api/folders/members` | POST | `withRequestOwnerId` + library gate | folder | signed cookie / anon | |
| `/api/generate/agent-profiles` | POST | `guardClientGeneration` (`hostedAuthGate` + stage owner when `stageId`) | stage when present | origin + cookie | |
| `/api/generate/image` | POST | independent-request + `guardClientGeneration` | owner lease / stage | media lease may skip when background on | |
| `/api/generate/scene-actions` | POST | `guardClientGeneration` | stage when present | unchanged | |
| `/api/generate/scene-content` | POST | `guardClientGeneration` | stage when present | unchanged | |
| `/api/generate/scene-outlines-stream` | POST | `guardClientGeneration` | stage when present | unchanged | |
| `/api/generate/tts` | POST | independent-request + `guardClientGeneration` | owner lease | media lease may skip when background on | |
| `/api/generate/video` | POST | independent-request + `guardClientGeneration` | owner lease | media lease may skip when background on | |
| `/api/generate/voice` | POST | independent-request + `guardClientGeneration` | owner lease | media lease may skip when background on | |
| `/api/generate-classroom` | GET, POST | `withGenerationRequest` | job/stage | signed cookie | job protocol unchanged |
| `/api/generate-classroom/[jobId]` | GET | `withGenerationRequest` | job | signed cookie | |
| `/api/generate-classroom/[jobId]/cancel` | POST | `withGenerationRequest` | job | signed cookie | |
| `/api/generate-classroom/[jobId]/confirm` | POST | `withGenerationRequest` | job | signed cookie | |
| `/api/generate-classroom/[jobId]/outline` | PATCH | `withGenerationRequest` | job | signed cookie | |
| `/api/generate-classroom/[jobId]/retry` | POST | `withGenerationRequest` | job | signed cookie | |
| `/api/generate-classroom/assets` | POST | `withGenerationRequest` | job/material | signed cookie | |
| `/api/generate-classroom/model-snapshots` | POST | `withGenerationRequest` | snapshot owner | signed cookie | |
| `/api/generate-classroom/search-snapshots` | POST | `withGenerationRequest` | snapshot owner | signed cookie | |
| `/api/health` | GET | public minimal | none | same | not user data |
| `/api/health/ready` | GET | public operational flags | none | same | Docker probe |
| `/api/kv` | GET, PUT | `requirePrincipal` + origin on PUT; owner-bound SQL | `account_kv` | 401 hosted-not-enabled | key whitelist |
| `/api/learning/check` | POST | `hostedAuthGate` | request/stage | unchanged | no durable stage id on the check body |
| `/api/learning/coach` | POST | `hostedAuthGate` + `refuseForeignStagePost` on `learningContext.stageId` | stage | unsigned `anon:` library still allowed | gate only; GET not served |
| `/api/learning/teach-back` | POST | `hostedAuthGate` + `refuseForeignStagePost` on `source.stageId` | stage | unsigned `anon:` library still allowed | GET **405**; POST-only |
| `/api/materials` | GET, POST | `withRequestOwnerId` | material owner | signed cookie | Pro-gated |
| `/api/materials/[id]` | GET | `withRequestOwnerId` | material | signed cookie | |
| `/api/parse-pdf` | POST | `runIndependentHeavyTaskRequest` | owner lease | may skip without DB | |
| `/api/pbl/v2/evaluate` | POST | `hostedAuthGate` | request/stage | unchanged | |
| `/api/pbl/v2/instructor` | POST | `hostedAuthGate` | request/stage | unchanged | |
| `/api/pbl/v2/open-task` | POST | `hostedAuthGate` | request/stage | unchanged | |
| `/api/pbl/v2/simulator` | POST | `hostedAuthGate` | request/stage | unchanged | |
| `/api/pbl/v2/task/update` | POST | `hostedAuthGate` | request/stage | unchanged | |
| `/api/persistence/[...path]` | GET, POST, PUT, PATCH, DELETE | session; no `PERSISTENCE_DEV_TOKEN`; hosted runtime/asset/document SQL bind `app.owner_id` | document/runtime/asset | dev token + signed cookie | `tests/persistence/server-auth.test.ts`; document-access tests |
| `/api/provider/probe-models` | POST | `hostedAuthGate` | none | unchanged | no platform secrets |
| `/api/proxy-media` | POST | `hostedAuthGate` | URL SSRF rules | unchanged | |
| `/api/quiz-grade` | POST | `hostedAuthGate` | request/stage | unchanged | |
| `/api/server-providers` | GET | `hostedAuthGate` | none | unchanged | no secrets |
| `/api/skills/[id]` | GET | builtin zip public; user skill `withRequestOwnerId` | user skill | signed cookie | same as agent skills export |
| `/api/stage-meta/[stageId]` | GET | `withRequestOwnerId` + library gate | stage | signed cookie | private; no ownerId leak |
| `/api/stages` | GET, POST | `withRequestOwnerId` + library gate | stage | signed cookie / anon | Pro may be off when hosted |
| `/api/stages/[id]` | GET, PATCH, PUT, DELETE | `withRequestOwnerId` + library gate | stage | signed cookie / anon | |
| `/api/stages/[id]/freshness` | GET | `withRequestOwnerId` + library gate | stage | signed cookie / anon | |
| `/api/stages/[id]/generation-complete` | POST | `withRequestOwnerId` + library gate | stage | signed cookie / anon | |
| `/api/stages/[id]/manifest` | GET | `withRequestOwnerId` + library gate | stage | signed cookie / anon | |
| `/api/stages/[id]/publish` | POST | `withRequestOwnerId`; hosted returns `SHARING_DISABLED` | stage | may publish | |
| `/api/stages/[id]/scenes` | GET | `withRequestOwnerId` + library gate | stage | signed cookie / anon | |
| `/api/stages/[id]/status` | GET | library gate (owner via stage meta) | stage | signed cookie / anon | |
| `/api/stages/[id]/unpublish` | POST | `withRequestOwnerId` + library gate | stage | signed cookie / anon | |
| `/api/transcription` | POST | `hostedAuthGate` | none | unchanged | |
| `/api/usage` | GET | `requirePrincipalIfHosted`; filter `ownerId` | usage rows | deployment-level rows | rows without owner hidden when hosted |
| `/api/verify-image-provider` | POST | `hostedAuthGate` | none | unchanged | |
| `/api/verify-model` | POST | `hostedAuthGate` | none | unchanged | |
| `/api/verify-pdf-provider` | POST | `hostedAuthGate` | none | unchanged | |
| `/api/verify-video-provider` | POST | `hostedAuthGate` | none | unchanged | |
| `/api/web-search` | POST | `hostedAuthGate` | none | unchanged | |

`withRequestOwnerId` / `withGenerationRequest` / `guardClientGeneration` all call `resolveGenerationOwnerAsync`, which uses `requirePrincipal` when hosted and the signed anonymous cookie when not.

Worker / generation-job claim loops do **not** use request-bound `app.owner_id`; they keep the shared pool (system role). That is required for cross-owner queue fairness and is not a browser identity.
