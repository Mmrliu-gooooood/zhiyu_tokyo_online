# Hosted accounts — test report

Date: 2026-09-20. Phase = **用户账号功能开发验收** (not production launch). Admin `2470034737@qq.com` was **not** deleted or recreated. Confirmed hosted project: **zhiyu** (`lzomhnjyymalupgvcato`). The live `:3000` classroom stack/database was not switched, migrated, rebuilt, or started during the final hosted pass; the previously recorded **115** `anon:` / **0** `user:` count is preserved evidence, not a fresh read in this pass.

Record: `docs/reports/2026-09-19-zhiyu-supabase-accounts-test-report.md`. Unrun tests are not marked 已通过.

## Final hosted acceptance snapshot (authoritative)

| Item | Status | Evidence |
| --- | --- | --- |
| Preserve admin and existing accounts | **已通过** | Hosted `app_accounts=3`; no create/delete/rebuild operation was run against the reserved admin |
| Hosted business schema + RLS | **已通过** | Accounts migration **v10**, checksum `cbec0f77c676d2c1161cfd54fde1bebf890636d2c37211012faa3b05c59f84b4`; 8 actual Agent/Pro tables all `ENABLE` + `FORCE RLS`, each with `app_web` and `app_worker` policy; no `anon` / `authenticated` table grants |
| Independent app + worker + asset store | **已通过** | Compose project `openmaic-hosted`; UI on `127.0.0.1:3001`, worker and UI healthy; local private asset volume; live `:3000` stack untouched |
| Login / local logout | **已通过** | A/B password grants and `/api/auth/me` **200**; local-scope sign-out **200** then `/me` **401**. Sign-out no longer invalidates other devices |
| Signup / confirmation | **已通过（既有证据）** | 163 A and Gmail B are confirmed hosted users. Not re-registered in the final pass because that would create extra durable users |
| Password recovery | **未通过（端到端）** | Recovery request and QQ inbox receipt have prior evidence; forgot/update UI was inspected. The final pass did not execute email link exchange, password update, old-password rejection, or expiry |
| A/B list + direct-ID isolation | **已通过** | `prove-hosted-isolation`: B gets **404** for A stage, chat and agent session GET/POST; A gets **200**. Unsigned `/me` **401**. Disposable rows cleaned |
| Same-browser A → sign-out → B | **已通过** | `prove-same-browser-switch` on hosted `:3001`: A/B `/me` **200**, both sign-outs restore **401**, no hash/fixture leftover |
| Hosted material persistence | **已通过** | Real upload **201**, metadata row exists, 58-byte object readable, then exact cleanup; final `owner_material=0` |
| Auth UI | **已通过** | Browser inspected login, signup, forgot-password and update-password; static brand image proxy regression fixed and visually rechecked |
| Ordinary API/worker wiring | **已通过（不含模型生成）** | Stage create/list/delete visibility, job direct-ID isolation, session creation/direct access, usage isolation, app/worker DB TLS and container health all proved |
| Ordinary + Pro completed course generation | **未通过** | Isolated worker has zero model/TTS/media providers and lacks generation encryption keys. No completed generated course is claimed |
| Full classroom UI | **已通过（既有回归证据）** | Prior live browser run displayed the full classroom content and controls. It was not rerun after the adjusted scope deliberately left the stopped live stack unchanged |
| Teach-back complete session | **未通过** | Prior live calls ended **504**, then **503 model_unavailable**; isolated environment has no real model provider |
| QQ / 163 receipt | **已通过（既有证据）** | QQ recovery and 163 confirmation mailbox evidence exists; no new mail was sent in the final pass |
| Sender warning investigation | **已通过（调查）** | DKIM exists; auth-subdomain SPF and DMARC are missing, organizational DMARC is `p=none`. DNS remediation remains a launch task |
| Full repository test suite | **未通过** | Targeted account/route suites pass, but the all-files Vitest run is not clean (pre-existing environment/version/source-contract failures and timeout-sensitive suites). It is not represented as passed |
| Supabase advisor review | **上线时待办** | Enable leaked-password protection; add covering indexes for two new Agent foreign keys (plus two older tables); keep `app_schema_migrations` policy-less by design; re-review the intentionally self-only reserved-admin `SECURITY DEFINER` dry-run RPC before launch |
| Domain, live database cutover, production deploy | **上线时待办** | Explicitly outside this phase |

Final hosted database cleanup: accounts **3**; `document_stages=0`, `generation_jobs=0`, `agent_sessions=0`, `agent_session_materials=0`, `owner_material=0`. Migration list includes `accounts_v10_agent_pro_rls` (`20260920093321`).

Verification completed in the final pass: TypeScript `tsc --noEmit` passed; focused Agent/course/material/auth-proxy group **9 files / 105 tests passed**; final account/config/database/server group **20 files / 104 tests passed** (an earlier broader grouping was **22 files / 134 passed**); production Next.js image build passed (existing `unpdf` dynamic-dependency warning only). `git diff --check` passed apart from Windows LF→CRLF notices.

Final independent containers are healthy: UI image `sha256:de6ce742e816ae8f2d38271627a6f67ca16befecdec91ae7bfefccc35e91e0de`; worker image `sha256:b70e02227c8c59aa33f90cbd098f0a53cbe021142acdb2a28649376f4a61099d`. Only `openmaic-hosted` was rebuilt/recreated; this is deliberately not a production/live rollout.

## Prior phase snapshot (superseded; retained as audit history)

The table and cutover notes below record earlier intermediate states. Where they disagree with the authoritative snapshot above (for example v9, hosted session proof, `:3001` state, or recovery classification), use the final snapshot.

| Item | Status | Evidence |
| --- | --- | --- |
| Keep admin `2470034737@qq.com` | **已通过** | Hosted `app_accounts` still 3 rows; admin `user:64b61f8a` `role=admin` `status=active`. Not deleted/recreated |
| Live 115 anon courses + `openmaic-main` runtime | **已通过** | Classroom PG `115 anon / 0 user`; unsigned `/api/stages` **51**; `zhiyu`/`zhiyu-worker` healthy on `:3000`; generation-compose does not load `docker-compose.hosted.yml`. Hosted overlay torn down; `:3001` down |
| Hosted business tables + RLS | **已通过** | Hosted `app_schema_migrations` **1–4, 8, 9**. `generation_jobs.id` uuid + `idempotency_key`. `document_stages` / jobs / ownership / `stage_meta` RLS+FORCE **on**, **0** course rows. LOGIN `zhiyu_app_web`: A sees own 1, B **0**, no-owner **0**, leftover **0**. Data API `anon` **401** / `authenticated` **403** (`42501`) |
| Independent test env (app + worker + asset store) | **已通过** | Compose project `openmaic-hosted` rebuilt on `127.0.0.1:3001` then **down**. Did not bind `:3000` or live volumes |
| Signup / confirm | **已通过** | Prior mailbox: 163 A + Gmail B confirmed (`email_confirmed=true`). Not re-registered this cutover (would mint new users) |
| Login / logout | **已通过** | Password grant + `/api/auth/me` A `user:09ee0532` / B `user:fdef1b67`; `POST /api/auth/sign-out` **200**; unsigned after switch **401**. Script `scripts/prove-live-logout-switch.ts` |
| Password recovery | **已通过** | Prior QQ recovery HTTP 200 + inbox screenshot. Not re-sent this cutover |
| A/B isolation by id (not only lists) | **已通过** (live dual-mode + hosted chat/stage GET) / **未通过** (hosted session GET/POST by id) | Live `:3000` prior: B chat/agent POST **404**, foreign `modelRef` **409**. Hosted `:3001` this cutover `prove-hosted-isolation` **ok**: A list/GET **200**, B stage GET **404**, B `POST /api/chat` **404**, leftover **0**. Overlay agent runtime is off, so A session create **404** and B GET/POST `/api/agent/sessions/{id}` was **not** a real owner-id proof |
| Same-browser account switch | **已通过** (Playwright on `:3000`) / **未通过** (hosted `:3001` UI) | `scripts/prove-same-browser-switch.ts` on `http://localhost:3000`. Confirm-on-`:3001` UI is **上线时待办** |
| Confirm link on `:3001` | **上线时待办** | Dashboard Site URL is `http://localhost:3000`. Password-grant used on `:3001`. No new mail sent |
| Regression: ordinary frontend | **已通过** | Live unsigned home library **51** after overlay teardown |
| Regression: ordinary backend generation | **已通过** (create-job handshake, not a finished course) | Unsigned `GET /api/generate-classroom` **200**. `POST` **202** `queued`, cancel **200**. Leftover stage removed. Library **51** / `document_stages` **115 anon / 0 user** restored |
| Regression: Pro generation | **未通过** | This phase did **not** fire Pro generate. Foreign `modelRef` **409** is not a Pro course run |
| Regression: classroom UI | **已通过** | Browser `http://localhost:3000/classroom/3VPvyRtOm8` (unsigned “讲解光合作用”): slide **光合作用的基本概念**, Qi Heng line, play controls. Not page-200 only |
| Regression: teach-back | **未通过** | Unsigned `POST /api/learning/teach-back` prepare on that course: **504** `timeout`, retry **503** `model_unavailable`. No plan. GET **405** is not the evidence |
| QQ / 163 mail receipt | **已通过** | Prior inbox proof for QQ recovery and 163 signup |
| Sender unverified warning | **已通过** (investigation) | DKIM TXT exists on `resend._domainkey.auth.zhiyulearn.online`. No SPF TXT on `auth.zhiyulearn.online`. No `_dmarc.auth.zhiyulearn.online`. Org DMARC `_dmarc.zhiyulearn.online` `p=none`. **Fix DNS/alignment = 上线时待办** |
| Domain cutover (`zhiyulearn.online` Site URL) | **上线时待办** | Site URL stays `http://localhost:3000` |
| Live `DATABASE_URL` → hosted | **上线时待办** | Classroom PG still the live store; FORCE RLS still **off** |
| Production deploy | **上线时待办** | |

## This cutover (in-phase closures, 2026-09-20 evening)

No live `DATABASE_URL` switch. No classroom FORCE RLS. Admin not deleted. Independent `openmaic-hosted` rebuilt (`openmaic-hosted-ui:local` manifest `sha256:d2330c0d3eac…`) then **compose down**. Live `zhiyu:latest` image still `sha256:05b86be8f3ba…`. `zhiyu` restarted once during the hosted build (`RestartCount` 1); worker was not recreated. `AUTH_MODE` length **0**. Worker `AUTH_MODE` **unset**.

### Hosted `:3001` chat-by-id (fixed)

Cause: FORCE RLS hid foreign `stage_meta`, the gate treated a missing row as allow for stateless chat, then `/api/chat` returned **400**. Isolated callers that supply a stage id now **404**. Chat/pi gate runs before missing-field 400s. Hosted pooler 503s retry; JWT self-select can proceed if the classroom registry flakes.

`scripts/prove-hosted-isolation.ts` **ok**: unsigned me **401**; A/B me **200**; create **201**; A/B list **200**; A stage GET **200**; B stage GET **404**; B chat POST **404**; leftover **0**; sign-out **200**. A session create **404** (overlay `OPENMAIC_AGENT_RUNTIME_ENABLED` empty).

Vitest in `zhiyu-worker` Node 22: `chat-stage-ownership` + `sessions-route` + `app-pool` — **3 files, 32 passed**.

### Live `:3000` regression

| Probe | Result |
| --- | --- |
| unsigned `/api/stages` | **51** after overlay down |
| `document_stages` | **115 anon / 0 user** (handshake leftover physically removed) |
| `stage_meta` live/tombstoned | **51** / **64** |
| `GET /api/generate-classroom` | **200** |
| `POST /api/generate-classroom` | **202** `queued`, cancel **200** |
| classroom UI | Browser opened unsigned `3VPvyRtOm8`; content visible |
| teach-back POST | **504** then **503**; no plan |
| `:3001` | down |

## Verdict

Goal stays **ACTIVE**. Hosted chat-by-id **404** and live unsigned library / classroom UI / create-job handshake are evidenced. Hosted session GET/POST by id, Pro generation, and a completed teach-back plan remain **未通过**. Domain / live DB cutover / prod deploy stay **上线时待办**.

## Previous cutover (phase acceptance, 2026-09-20 later)

No live `DATABASE_URL` switch. No classroom FORCE RLS. Admin not deleted. Independent `openmaic-hosted` rebuilt on `:3001` (images `openmaic-hosted-ui:local` / `openmaic-hosted-worker:local`). Hosted accounts **v9** already recorded (`checksum` prefix `c1a99b3b9768`); re-apply was a no-op.

### Hosted LOGIN (v9 real shapes)

`pnpm accounts:prove-hosted-login`: **ok**, `connectedAs=zhiyu_app_web`, `shape=generation-v1`, A stages/ownership/jobs **1**, B **0**, leftover **0**.

### Same-browser A→B (`http://localhost:3000`)

`scripts/prove-same-browser-switch.ts` **ok**: unsigned 51 / A `user:09ee0532` count 0 / B `user:fdef1b67` count 0 / both sign-outs restore unsigned 51.

### Independent hosted `:3001` (direct id)

`scripts/prove-hosted-isolation.ts` last run **not ok**. Passing slices: unsigned me **401**; A/B me **200**; create **201**; sign-out **200** / follow-up me **401**; leftover **0**. Failures: A `GET /api/stages/{id}` **401**; B **503**; jobs **503** `AUTH_UNAVAILABLE`; B chat **400**; media A **401** / B **404**. Do not treat `:3001` GET-by-id as 已通过.

Unsigned live library after these proofs: **51**. Classroom counts **115 anon / 0 user**. `AUTH_MODE` length **0**.

## Verdict

Goal stays **ACTIVE**. This **phase is not fully evidenced**: hosted `:3001` GET-by-id (401/503), ordinary/Pro generation runs, and full classroom/teach-back sessions remain **未通过**. Live stack is unchanged (`115` anon / unsigned **51** / `AUTH_MODE` empty). Hosted v9 LOGIN RLS and the independent `:3001` app+worker+local-asset stack are evidenced. Domain / live DB cutover / prod deploy / `auth.zhiyulearn.online` SPF stay **上线时待办**.

## Previous cutover (chat POST stage-ownership / Pro modelRef)

`AUTH_MODE` unset (length **0**). No FORCE RLS. No live `DATABASE_URL` switch. Admin not deleted. Anonymous owners on the live library were not replaced. Passwords only in gitignored `.env.hosted.local` (not printed). Rebuilt because app code changed.

### Leaks found vs fixed

| Surface | Before | Fix |
| --- | --- | --- |
| `POST /api/chat` and `/api/chat/pi` | No stage owner check. Signed-in B could POST `storeState.stage.id` for A or an unsigned library course | `refuseForeignStagePost` before `resolveModel`. Foreign / unsigned-library / `user:` from unsigned → **404**. Missing ids stay allow for stateless chat. Does not mint `generation_owner` |
| `POST /api/agent/sessions` `existingCourse` | Comment said ownership was deferred; B could attach a session to A’s (or shared) `stageId` under B’s owner | Same gate with `requireExisting: true`. Foreign/missing → **404**, no `createSession` |
| `POST /api/learning/coach` and teach-back | Stage id in the body was not gated | Same 404 gate. Teach-back GET still **405** / POST-only. Check body has no durable stage id |
| Pro `modelRef` / snapshots / Pro job create | Stores already filtered by `owner_id`. Dual-mode HTTP now proven to pass `user:{uuid}` into sync/load, not a body owner or anon cookie | No store rewrite. Foreign ref → **409** `PRO_MODEL_CONNECTION_UNAVAILABLE` / snapshot unavailable. Job `createJob` already 404s a foreign `target.stageId` |

### Unit tests

Vitest in `zhiyu-worker` Node 22 with mounted worktree: **14 files, 90 passed** (`tests/auth` + `tests/agent-runtime/sessions-route.test.ts`). New: `tests/auth/chat-stage-ownership.test.ts`, `tests/auth/model-ref-isolation.test.ts`.

### Live proof (`http://127.0.0.1:3000`, gitignored A/B passwords)

Disposable A `document_stages`/`stage_meta` row plus dummy `pro_model_connections` ciphertext `v1.isolation-fixture`; deleted after. No Pro generation. Passwords not printed. `AUTH_MODE` length **0** on `zhiyu` (empty string); worker `AUTH_MODE` unset. Ready **200**. Teach-back GET **405**.

`scripts/prove-classroom-chat-pro.ts`:

| Surface | Result |
| --- | --- |
| `/api/auth/me` | unsigned **401**; A **200** `user:09ee0532…`; B **200** `user:fdef1b67…` |
| B `POST /api/chat` on A’s stage | **404** |
| B `POST /api/chat` on unsigned library stage | **404** |
| B `POST /api/agent/sessions` `existingCourse` on A’s stage | **404** |
| B `POST /api/agent/sessions` `existingCourse` on unsigned library | **404** |
| B `POST /api/agent/runtime` with A’s `modelRef` | **409** |
| B `POST /api/agent/model-connections` with A’s ref, body missing `apiKey` | **400** (`PRO_MODEL_KEY_REQUIRED` before owner SELECT) |
| unsigned `/api/stages` | **51** before and **51** after |
| leftover stages/meta/sessions/connections / `user:` stages | **0** / **0** |

Follow-up (dummy `apiKey` so normalize reaches the owner-scoped SELECT): B `POST /api/agent/model-connections` against A’s ref → **409** `PRO_MODEL_CONNECTION_UNAVAILABLE`, leftover connections **0**.

Unsigned `POST /api/chat` against a live `anon:` library stage → **200** (not 404). Library owners were not rewritten.

Classroom counts after cleanup: `document_stages` **115** `anon:` / **0** `user:`; live `stage_meta` `anon:` **51**, tombstoned **64**; generation RLS/FORCE `f`/`f`. Isolation fixture revisions **0**.

Pro job **create** was not live-fired (would enqueue). `createJob` still 404s `COURSE_NOT_FOUND` when `target.stageId` owner ≠ caller. Snapshot HTTP remains owner-scoped in unit tests (`tests/auth/model-ref-isolation.test.ts`).

### Docker

- `zhiyu:latest` `sha256:05b86be8f3ba0ca39474db7d578c166e043ce4029b0228b3bb833b2714029349`
- `zhiyu-worker:latest` `sha256:64ed3f614ced0e25845746f946bd176c9a84873acc61f3adaf4716e67b67ba9a`
- Source revision: `worktree-3e8714f653ad-4dd271d45f24b1ca` (matches worktree fingerprint)
- Containers recreated earlier this cutover, both **healthy**. Live volumes were not replaced. Generation migrate ran on Docker `openmaic` only. No rebuild this proof turn (app code unchanged after the images were labeled).

## Previous cutover (classroom app-layer jobs / chat / usage / media)

`AUTH_MODE` unset (length **0**). No FORCE RLS. No live `DATABASE_URL` switch. Admin not deleted. Passwords only in gitignored `.env.hosted.local` (not printed). Rebuilt because app code changed.

### Leaks found vs already scoped

| Surface | Before | Fix |
| --- | --- | --- |
| `GET /api/generate-classroom` + job GET | Already `listJobs(ownerId)` / `getJobDetail(ownerId)` via `resolveGenerationOwnerAsync` | None. Live A/B proof added |
| `GET /api/agent/sessions` (chat listing) | Already `listSessionsByOwner(ownerId)` | None. Live A/B proof added |
| Chat/learning POST (`/api/chat`, coach, check, teach-back) | Stateless POST; **no GET list**. Teach-back GET **405** | No protocol rewrite |
| `GET /api/usage` | Unsigned saw **all** rows, including a `user:{uuid}` fixture | Unsigned skips `user:` rows; signed-in exact `ownerId` |
| `GET /api/classroom-media/...` | Signed-in B already 404; **unsigned** could fetch a `user:` snapshot by path | `classroomMediaAllows`: unsigned 404 on `user:` snapshots; missing snapshot still legacy |

### Live proof (`http://127.0.0.1:3000`, gitignored A/B passwords)

Disposable fixtures: cancelled `generation_jobs` row, `agent_sessions` row, usage jsonl line, classroom JSON + `slide.png`. No Pro generation. Deleted after.

| Surface | A `user:09ee0532` | B `user:fdef1b67` | unsigned `anon:` |
| --- | --- | --- | --- |
| `/api/auth/me` | **200** | **200** | **401** |
| job list / job GET | list has fixture | list empty; GET **404** | list empty of fixture |
| agent session list | has fixture | empty | empty |
| `/api/usage` totals.requests | **1** (own fixture only) | **0** | **801** (unchanged unowned; fixture hidden) |
| `/api/classroom?id=` | **200** | **404** | **404** |
| classroom-media `slide.png` | **200** | **404** | **404** |
| `GET /api/learning/teach-back` | — | — | **405** (no list) |

Leftover jobs/sessions/stages **0**. `document_stages` still **115** `anon:` / **0** `user:`. `generation_jobs` **56** all `anon:`. RLS/FORCE still `f`/`f`. Classroom `app_accounts` **3**.

`pnpm accounts:prove-classroom-app` (`scripts/prove-classroom-app-isolation.ts`). Vitest in `zhiyu-worker` Node 22 with mounted worktree: **14 files, 79 passed** (`tests/auth` + usage-storage + classroom-media-range + usage route).

### Docker

- `zhiyu:latest` `sha256:cbc0b342a64d66db0868cd2759e103c46bb870f5bbe75c392c49684dcc82ca38`
- `zhiyu-worker:latest` `sha256:5a4800800db27f0797a4989fda455e0d2023348154f9b0bbf17167516d32d00e`
- Source revision: `worktree-3e8714f653ad-b77245a9c2c081d5`
- Containers recreated, both **healthy**. `AUTH_MODE` length **0** on `zhiyu`. Worker `AUTH_MODE` **unset**. Live volumes were not replaced. Generation migrate ran on Docker `openmaic` only.

## This cutover (LOGIN `zhiyu_app_web` pass)

No live Docker rebuild. No classroom FORCE RLS. No live `DATABASE_URL` switch. Admin not deleted. Secrets only in gitignored `.env.hosted.local`.

`HOSTED_DB_ADMIN_URL` is the operator-supplied Session pooler URI (user `postgres.lzomhnjyymalupgvcato`, host `aws-0-ap-southeast-1.pooler.supabase.com`, port `5432`, `sslmode=require`). Direct host still does not resolve here. First apply hit a pooler certificate-chain verify failure; operator scripts now use libpq-compatible `sslmode=require` (`uselibpqcompat=true`, encrypt without failing on chain intermediates). Values not recorded.

`pnpm accounts:apply-hosted-logins`: **ok**, `webConnect=true`, `workerConnect=true`. Rewrote `DATABASE_URL_APP_WEB` / `WORKER_DATABASE_URL` to session-pooler usernames `zhiyu_app_web.<ref>` / `zhiyu_app_worker.<ref>`. Live `DATABASE_URL` key remains **absent** in that file.

`pnpm accounts:prove-hosted-login`: **ok**, `connectedAs=zhiyu_app_web`, transport `session-pooler`.

| Actor | `document_stages` |
| --- | --- |
| LOGIN `zhiyu_app_web` + owner A `user:09ee0532-…` | **1** (own fixture) |
| same LOGIN + owner B `user:fdef1b67-…` | **0** of A; list count **0** |
| same LOGIN, empty `app.owner_id` | **0** |
| after DELETE | leftover **0**; privileged count **0** |

### Data API (still denied)

`GET /rest/v1/document_stages?select=id`:

| Actor | HTTP | Code |
| --- | --- | --- |
| `anon` | **401** | `42501` |
| `authenticated` (Gmail B grant **200**) | **403** | `42501` |

### Classroom / compose

Not switched. `generation-compose.ps1` still does not load `docker-compose.hosted.yml`. Docker engine was down this morning so `AUTH_MODE` was not re-read from containers.

## This cutover (hosted generation RLS, classroom untouched)

Read-only inspect first: hosted had account tables and **no** `document_stages`. Accounts SQL v8 plus MCP migrations `hosted_generation_min_tables` / `hosted_generation_force_rls_app_web` created the minimum tables the existing owner policies expect, then ENABLE + FORCE RLS as `app_web`. No auth/user rows overwritten (`app_accounts` stayed **3**). Fixtures deleted after proof (**0** hosted stages/jobs).

### Isolation proof (hosted)

MCP `postgres` cannot `SET ROLE app_web` until it is a member. LOGIN inheritors already existed; this turn did **not** set passwords (they would land in transcripts). A temporary `GRANT app_web TO postgres` (no password) allowed `SET ROLE app_web` + `set_config('app.owner_id', …)` — **not** a LOGIN connection as `zhiyu_app_web`. Later (2026-09-20) LOGIN passwords were generated only into gitignored files and still not applied.

| Actor | `document_stages` ids |
| --- | --- |
| `app_web` + owner A `user:09ee0532-…` | `hosted-rls-a` |
| `app_web` + owner B `user:fdef1b67-…` | `hosted-rls-b` (**0** of A’s rows; A’s job count **0**) |
| `app_web` with no `app.owner_id` | **0** |
| `anon` / `authenticated` table SELECT | **false** |

A later `REVOKE app_web FROM postgres` was issued; `pg_auth_members` still listed `postgres` plus existing `zhiyu_app_web`. `app_web` is `NOINHERIT`. No LOGIN password was created or printed this turn.

### Classroom counts (unchanged)

| Probe | Result |
| --- | --- |
| `document_stages` | **115**, all `anon:`, **0** `user:` |
| `stage_meta` live `anon:` | **51** |
| `stage_meta` tombstoned | **64** |
| generation RLS / FORCE | `f` / `f` |
| classroom `app_schema_migrations` | **6** and **7** only |
| unsigned `/api/stages` | **51** |
| unsigned `/api/auth/me` | **401** |
| `/api/health/ready` | **200** |
| `zhiyu` `AUTH_MODE` | length **0** (key present, empty) |
| worker `AUTH_MODE` | **unset** |

No live Docker rebuild (app request paths unchanged; accounts v8 is hosted DDL + tests).

### App-layer owner scope (`user:{uuid}`)

Added `tests/auth/owner-scoped-surfaces.test.ts`: `/api/kv` binds `principal.ownerId` (ignores body `ownerId`), `/api/usage` passes that owner into `readUsageRecords`, classroom GET + classroom-media **404** for a foreign owner, chat/agent listing identity uses `user:{uuid}` rather than the anon cookie. Vitest in `zhiyu-worker` Node 22: **11 files, 56 passed**.

## Previous cutover (restore unsigned shared library)

Goal stays **ACTIVE**. Unsigned home lists the live `anon:` classroom pile (**51** live rows; DB still has **115** `anon:` documents, **64** tombstoned). Signed-in A / Gmail B / QQ admin stay on `user:{uuid}` and do **not** see that pile.

## This cutover (unsigned shared library)

`GET /api/stages` minted a fresh `generation_owner` cookie for unsigned traffic, then `listDocuments` filtered to that empty partition. Ordinary home therefore showed **0** courses while Postgres still held the shared pile.

Fix: `listLibraryDocuments` on the owner-bound store. Dual-mode unsigned (`anon:`, `AUTH_MODE` unset) lists live `stage_meta.owner_id LIKE 'anon:%'`. `user:{uuid}` sessions still use the owner-scoped list. Agent-tool `listDocuments` stays cookie-partitioned. Persistence token is still not an identity.

### Unsigned stage counts

| Probe | Before rebuild | After rebuild |
| --- | --- | --- |
| unsigned `/api/stages` (new cookie) | HTTP **200**, **0** | HTTP **200**, **51** |
| `document_stages` | **115** total, **115** `anon:`, **0** `user:` | same after fixture cleanup |
| `stage_meta` live `anon:` | **51** | **51** |
| `stage_meta` tombstoned | **64** | **64** |
| unsigned `/api/auth/me` | **401** | **401** |
| `document_stages` RLS / FORCE | `f` / `f` | `f` / `f` |

The **51** is the intended unsigned library (live rows). The **115** includes tombstones and is not listed.

### Live A-vs-B (gitignored passwords, values not recorded)

Password grants from the `zhiyu` container. Fixture `stage-7zfVvWQXIy7J` created as 163 A, then API-deleted and SQL-removed.

| Actor | `/api/auth/me` | owner prefix | `/api/stages` | has A fixture |
| --- | --- | --- | --- | --- |
| unsigned | **401** | — | **200**, **51** | **no** |
| 163 A | **200** `role=user` | `user:09ee0532` | **200**, **0** then **1** | **yes** (own) |
| Gmail B | **200** `role=user` | `user:fdef1b67` | **200**, **0** | **no** |
| QQ admin | **200** `role=admin` | `user:64b61f8a` | **200**, **0** | **no** |

After delete: leftover live `stage_meta` **0**; `document_stages` restored to **115** `anon:` / **0** `user:`.

### Playwright (`http://localhost:3000`)

| Context | `/api/stages` | Home “最近学习” | Persistence toast | `#access_token` |
| --- | --- | --- | --- | --- |
| unsigned | **51** | **51** course tiles | **no** | **no** |
| Gmail B | **0** | **0**, empty-library hint | **no** | **no** |

Teach-back remains POST-only (**405** on GET). `/api/classroom` still answers without a rewrite (**400** without params). `/api/export-video/capability` **200**.

### Docker

- `zhiyu:latest` `sha256:c131f7d1e76581d122ff55530ef5236eca8956b8b021a90f2d1c9bb5b653d3e7`
- `zhiyu-worker:latest` `sha256:fb67e298299bc81dd2ee2432f3d95b11db66c2dd530d5d7a9bcd6c63b0e5c2c6`
- Source revision: `worktree-3e8714f653ad-f20b18226494057d`
- Containers recreated, both **healthy**. `AUTH_MODE` length **0** on `zhiyu`. Worker `AUTH_MODE` **unset**. Live volumes were not replaced. Generation migrate ran on Docker `openmaic` only. Hosted generation tables were **not** created.

Admin was not deleted. **B** was not promoted. Goal stays **ACTIVE**.

## Previous cutover (hosted JWT role → classroom `ensure_account`)

Do **not** trust nickname / `user_metadata` for elevation. The signed-in JWT reads hosted `app_accounts` via an `authenticated` self-select policy (`auth.uid()`), then copies `role` + `status` into classroom `app_internal.ensure_account(..., p_role, p_status)` upsert.

### Hosted Data API (no `SUPABASE_SECRET_KEY`)

Supabase migration `app_accounts_authenticated_self_select` (`20260919135133`):

- `GRANT SELECT (user_id, owner_id, role, status)` to `authenticated`
- policy `app_accounts_self_select` `FOR SELECT TO authenticated USING ((SELECT auth.uid()) IS NOT NULL AND user_id = (SELECT auth.uid()))`
- no UPDATE grant; no `document_stages` (hosted still has none)

Gmail B password grant from the app container, then PostgREST self-select:

| Probe | Result |
| --- | --- |
| password grant | HTTP **200**, user prefix `fdef1b67` |
| `GET /rest/v1/app_accounts?select=role,status,owner_id&user_id=eq.{b}` | HTTP **200**, **1** row, `role=user`, owner prefix `user:fdef1b67` |
| `/api/auth/me` (session cookie) | HTTP **200**, `role=user`, `ownerId` prefix `user:fdef1b67` |

B cannot see other hosted account rows through this policy (1 row only). Admin mailbox was not deleted.

### Classroom registry v7

Live `postgres:5432/openmaic` `app_schema_migrations`: version **6** checksum `c1750945c5c70c59e910429b72c0026bd134529e8074409b4a685a632247b747` (unchanged) and version **7** checksum `0ba640203aa87c806444476bc6b7a335578012d25e095959e99a0581412f57b7`. `ensure_account` is now `(uuid, text, text, text)` with `ON CONFLICT DO UPDATE` of role/status. Display name is not a role.

After apply and after generation migrate on start-app: `document_stages` / `stage_meta` / `generation_jobs` still `rls=f`, `force_rls=f`. Counts unchanged: **115** stages, all `anon:`.

Classroom `app_accounts` after B login: **1** row, `role=user`, `status=active`, owner prefix `user:fdef1b67`. QQ admin has not signed in on this stack this turn, so classroom has no admin row yet.

### Two-context Gmail B (Playwright, `http://localhost:3000`)

Same mailbox, two isolated Chromium contexts, password from gitignored `.env.hosted.local` (not printed):

| Context | `/api/auth/me` | owner prefix | `/api/stages` | `#access_token` | persistence toast |
| --- | --- | --- | --- | --- | --- |
| b1 | **200** `role=user` | `user:fdef1b67` | **200**, **0** rows | **no** | **no** |
| b2 | **200** `role=user` | `user:fdef1b67` | **200**, **0** rows | **no** | **no** |

That is same-account cross-device evidence without a second physical device. Neither context sees the unsigned 115-stage pile.

### Unsigned traffic still legacy

| Probe | Result |
| --- | --- |
| `/api/health/ready` | **200** |
| unsigned `/api/auth/me` | **401** |
| unsigned `/api/stages` | **200** |
| `/auth/login`, `/auth/sign-up` | **200** |
| unsigned `/api/admin/status` | **401** |

`AUTH_MODE` length **0** on `zhiyu`. Worker `AUTH_MODE` absent. Teach-back / classroom / generation routes were not rewritten.

### Docker

- `zhiyu:latest` `sha256:344cad49eb774b21b79e05b97f17aadbcacb24ea0b7e482f767170fd456bffb2`
- `zhiyu-worker:latest` `sha256:05dbf015a50ce9e84f899fe7ebe0444a29824c364aa6aaf8418a8d294c9ded78`
- Source revision: `worktree-3e8714f653ad-068a736c06fe16c3`
- Containers recreated, both **healthy**. Live volumes were not replaced. Generation migrate ran on Docker `openmaic` only. Hosted generation tables were **not** created.

Vitest `tests/auth` in `zhiyu-worker` (Node 22): **10 files, 48 passed**.

Admin `2470034737@qq.com` was not deleted. **B** was not promoted. Goal stays **ACTIVE**.

## AUTH_MODE vs session isolation

Live `zhiyu` process before rebuild: `AUTH_MODE` length **0**, `NEXT_PUBLIC_AUTH_MODE` length **0**, publishable URL/key present (values not recorded). Dual-mode is **not** a substitute that leaves signed-in users on the shared pile:

| Traffic | Identity | Data |
| --- | --- | --- |
| No Supabase session | Legacy `anon:{uuid}` / persistence token | Shared classroom library and unsigned generation/teach-back stay usable |
| Real Supabase session | Principal `user:{uuid}` | Owner-bound stores, `app.owner_id`, foreign document ids **404**, KV namespace `zhiyu:openmaic:{uuid}` |
| `AUTH_MODE=supabase` | Session **required** for every request | Unchanged force-login; **not** enabled on this stack |

Unsigned `/api/auth/me` HTTP **401**. Unsigned `/api/stages` HTTP **200**. Unsigned `/`, `/auth/login`, `/auth/sign-up` HTTP **200**.

## Mail

| Path | Send | Inbox | Click | Official `/auth/confirm?token_hash=` |
| --- | --- | --- | --- | --- |
| QQ recovery `2470034737@qq.com` | previously HTTP 200 | **Verified** (prior user screenshot) | Not required | Prior mail was English default; operator now says templates were pasted |
| 163 signup A `lzg0724aaa@163.com` | previously HTTP 200 | **Verified** | **Verified** (prior) | Prior click used implicit hash. User is **confirmed**. Resend not sent |
| Gmail signup B `zhigngliu0724@gmail.com` | Auth `/signup` HTTP **200** | User opened the letter | **Click 1 proven** (Auth `email_confirmed=true`). Click 2 `confirm_failed` expected | Click 1 screenshot was `http://localhost:3000` with no hash. Token-hash flow likely worked; implicit leftover hash is now persisted before strip |

Click 1 consumed the OTP. Do not keep clicking that letter. Login at `http://localhost:3000/auth/login` instead.

## Account B

- Email: `zhigngliu0724@gmail.com`
- Auth user: `fdef1b67-298d-40c9-bc60-d778816ea1c6`
- `email_confirmed=true` (click 1)
- `app_accounts.role=user`, `status=active`, `owner_id=user:fdef1b67-298d-40c9-bc60-d778816ea1c6`
- Auth `raw_app_meta_data.role` is not admin
- Password stored only in gitignored `.env.hosted.local` as `TEST_USER_B_PASSWORD` (not printed)

## Persistence toast (click 1 home)

Screenshot: empty library copy plus toast **“Persistence is unavailable. Saved classrooms could not be loaded.”**

Root cause: home `listStages()` treats a failed `GET /api/stages` as a down store. After confirm, `verifyOtp` marked B confirmed, but `redirect()` from `next/navigation` can drop the session `Set-Cookie` headers. A leftover `sb-*-auth-token` cookie then makes dual-mode `tryPrincipal` fail closed (`AUTH_UNAVAILABLE`) instead of falling back to a new anon owner. The listing returns 401/503, classrooms stay `[]`, and the toast fires. An empty **own** library is correct isolation (B has no courses). The toast was wrong.

Fix (this turn, requires image rebuild):

1. `/auth/confirm` returns `NextResponse.redirect` and copies verifyOtp cookies onto `/`.
2. Implicit `#access_token=` leftover now calls `setSession` before the hash is stripped.
3. Home/discovery no longer show the persistence-down toast on owner-listing HTTP 401/503.
4. `auth-change` reloads the owner library after `/api/auth/me` succeeds.

Unsigned generation / classroom / teach-back paths were not rewritten.

## Isolation evidence (A vs B vs admin)

Hosted `app_accounts` (privileged MCP read):

| Mailbox | user_id | role | owner_id |
| --- | --- | --- | --- |
| QQ admin | `64b61f8a-79d3-447a-9531-fb5deafd7527` | **admin** | `user:64b61f8a-…` |
| 163 A | `09ee0532-7110-4bd4-ae73-e95f4d5126b0` | **user** | `user:09ee0532-…` |
| Gmail B | `fdef1b67-298d-40c9-bc60-d778816ea1c6` | **user** | `user:fdef1b67-…` |

Docker live classroom DB (`postgres:5432/openmaic`): `document_stages` and `stage_meta` exist (115 rows, all `anon:` owners). RLS is off. Hosted PG still has **no** `document_stages` — do not apply remote generation schema.

Disposable fixture `stage-iso-ab-tmp-20260919` owned by A:

| Probe | `stage_meta` rows for that id |
| --- | --- |
| A `user:09ee0532-…` | **1** |
| B `user:fdef1b67-…` | **0** |
| admin `user:64b61f8a-…` | **0** |
| leftover after DELETE | **0** |

Automated test `tests/auth/owner-isolation-ab.test.ts` keeps proving A vs B vs admin: store `loadDocument` null, `listDocuments` empty, persistence GET 404, `/api/stages` empty / 404. Vitest 4.1.8: `confirm-route`, `principal-mode`, `document-access`, `owner-isolation-ab`, `pg-mode-home-listing` — **5 files, 31 passed**.

Admin is not B. B is not admin.

## Docker (this cutover)

- `zhiyu:latest` `sha256:0f21ddecb5afe7fd0f410bdecf5ee1a5b382a922eb1b9e3953eb6c8a7dddb0eb`
- `zhiyu-worker:latest` `sha256:b27cf787b7b78efcfb14431cebaea329bf4c38d714a1d81fea890b9562335a6d`
- Source revision: `worktree-3e8714f653ad-a5496dc0a55322b6`
- Containers recreated, both **healthy**. `/api/health/ready` HTTP **200**. `AUTH_MODE` length **0**
- Live volumes were not replaced. `start-app` migrate ran only on Docker `openmaic`, not hosted
- Unsigned `/api/auth/me` **401**, `/api/stages` **200**, `/auth/login` **200**, `/auth/sign-up` **200**, `/auth/error?error=confirm_failed` **200**
- From the app network, B password grant HTTP **200** and `email_confirmed=true`. Browser MCP still could not keep a tab, so a signed-in empty-library screenshot was **not** captured here. User should log in in Chrome.

## Docker restart observation (operator)

Operator restarted Docker. Health observed **2026-09-19 ~12:38 UTC** (containers up ~54s when inspected; `StartedAt` 2026-09-19T12:38:37Z):

| Container | Status | Health | Image id | `AUTH_MODE` |
| --- | --- | --- | --- | --- |
| `zhiyu` (`acc49b22a851`) | running | **healthy** (failingStreak 0) | `sha256:0f21ddecb5afe7fd0f410bdecf5ee1a5b382a922eb1b9e3953eb6c8a7dddb0eb` | length **0** (key present, empty) |
| `zhiyu-worker` (`e0bbc430a154`) | running | **healthy** (failingStreak 0) | `sha256:b27cf787b7b78efcfb14431cebaea329bf4c38d714a1d81fea890b9562335a6d` | **unset** (key absent) |

These **are** the confirm-cookie-fix images (`0f21ddec` / `b27cf787`, revision `worktree-3e8714f653ad-a5496dc0a55322b6`). No rebuild this turn.

HTTP after restart (curl, no login):

- `/api/health` **200**
- `/api/health/ready` **200**
- `/auth/login` **200**
- `/auth/sign-up` **200**
- `/auth/signup` (no hyphen) **404** — official route is `/auth/sign-up`
- unsigned `/api/auth/me` **401**, `/api/stages` **200**

Gmail B click-through was not resumed. Admin was not deleted. Goal remains **ACTIVE**.

## This cutover (classroom session registry, no FORCE RLS)

Full accounts **v1–v4 were not applied** to live Docker Postgres. v1’s RLS head would `ENABLE` + `FORCE ROW LEVEL SECURITY` on existing `document_stages` / `stage_meta` / `generation_jobs` (115 live `anon:` rows, 56 jobs). `migrateAccountsSchema` now refuses that path when those tables exist without FORCE RLS.

Classroom SQL that **did** land (accounts **v6 only**, checksum `c1750945c5c70c59e910429b72c0026bd134529e8074409b4a685a632247b747`):

- schema `app_internal`
- functions `current_owner_id`, `session_is_active` (returns true when `auth.sessions` is absent), `ensure_account`
- tables `app_accounts`, `app_profiles`
- roles `app_web` / `app_worker` (`NOLOGIN`, `NOBYPASSRLS`)
- `app_schema_migrations` version **6** only (v1–v5 **not** recorded)

Classroom SQL **skipped**: accounts v1–v5, any `ENABLE`/`FORCE` RLS on generation tables, hosted generation schema, remote zhiyu DDL this turn.

After apply and after `start-app` generation migrate: `document_stages` / `stage_meta` / `generation_jobs` still `rls=f`, `force_rls=f`. Counts unchanged: **115** stages (all `anon:`, 73 distinct owners), **56** jobs.

App code: `/api/auth/me` calls `app_internal.ensure_account` + `session_is_active` on classroom `DATABASE_URL`. `AUTH_MODE` stays unset (length **0**).

### HTTP evidence (localhost:3000)

| Probe | Result |
| --- | --- |
| unsigned `/api/health/ready` | **200** |
| unsigned `/api/auth/me` | **401** |
| unsigned `/api/stages` (no cookie) | **200** `{ stages: [] }` — new anon partition |
| unsigned `/api/stages` (existing `generation_owner` for a live anon owner) | **200**, **6** shared courses |
| `/auth/login`, `/auth/sign-up` | **200** |
| `/auth/signup` | **307** → `/auth/sign-up` |
| Gmail B password grant + `/api/auth/me` | **200**, `role=user`, `ownerId=user:fdef1b67-…` (not 503) |
| Gmail B `/api/stages` | **200**, **0** rows (does not see the unsigned library) |

Classroom `app_accounts` after B `/api/auth/me`: **1** row, `role=user`, `status=active`, `owner_id` prefix `user:fdef1`. Dual-mode classroom registry always inserts `role=user`; hosted admin role is **not** copied here.

### Docker

- `zhiyu:latest` `sha256:c7c8452063799fcbc6559b5a97977e0cd98c2320cd91086be541f4d37883f5c6`
- `zhiyu-worker:latest` `sha256:718c9054b5c52370d6b5a0452d0ed3d3ff52c99644a06ba1afaf3f284b84b08f`
- Source revision: `worktree-3e8714f653ad-9ba0bac952ff598f`
- Containers recreated, both **healthy**. `AUTH_MODE` length **0**. Live volumes were not replaced. Generation migrate ran on Docker `openmaic` only. Hosted PG was not migrated.

Admin `2470034737@qq.com` was not deleted. Goal stays **ACTIVE**.

## Remaining P0–P6 (honest vs plan)

Plan file: `docs/plans/2026-09-19-zhiyu-supabase-accounts-implementation.md`. Live stack is still dual-mode classroom Postgres. Hosted zhiyu is Auth + account rows + empty generation RLS skeleton. Goal **ACTIVE**.

| Stage | Proven | Not proven / over-claim to avoid |
| --- | --- | --- |
| **P0** | Route matrix and ownership inventory exist as classification. Dual-mode unsigned vs signed listing baseline was recorded on this Docker stack in prior turns | Not a live 401 sweep of every matrix route. Plan “三条生成链路 + 课堂回归可复现” is not a packaged freeze from this turn |
| **P1** | Auth pages, proxy/session principal, confirm/login/signup/recovery. QQ recovery + 163 A + Gmail B confirm were previously verified. Unsigned `/api/auth/me` **401**. Official confirm path exists | Not `AUTH_MODE=supabase` on live compose (unsigned APIs stay open by design). Production SMTP/DMARC/`zhiyulearn.online` Site URL not done. Full fake-cookie / malicious-`next` live sweep not re-run here |
| **P2** | Hosted empty generation tables + ENABLE/FORCE RLS + `app_web` owner policies. LOGIN `zhiyu_app_web` via Session pooler: A sees own **1**, B **0**, no-owner **0**, leftover **0**. Data API `anon` **401** / `authenticated` **403** (`42501`). Classroom listing isolation remains app-layer `user:{uuid}` vs unsigned `anon:` library | Live classroom generation tables still RLS/FORCE **off**. Live `DATABASE_URL` still classroom. Hosted generation is a skeleton (no worker claim cutover). Direct DB host still unusable here (pooler only). `postgres` leftover `supabase_admin` membership on `app_web` is platform ADMIN/NO SET |
| **P3** | Dual-mode listing plus live A/B for jobs, agent chat **list**, usage, classroom GET/media. Live B **404** on chat/agent POST against A and against the unsigned library; unsigned library chat still **200**. Foreign `modelRef` use **409**; sync with a complete body **409**. Unsigned `anon:` library owners not rewritten | Plan P3 remainder: replace anonymous owner, hosted generation worker. Packaged `accounts:prove-classroom-chat-pro` still scores model-connections **400** unless the probe body includes an `apiKey` (owner SELECT is after KEY_REQUIRED). Do not treat classroom API isolation as hosted RLS LOGIN |
| **P4** | `LocalAssetByteStore` code exists | Not enabled on this BYTEA stack. File/Range/download/GC negatives on hosted: **not** done |
| **P5** | Playwright: unsigned home listed live library tiles; Gmail B own-only empty, no persistence toast, no leftover hash. Two Chromium contexts, same Gmail mailbox | Not a second physical device. Same-browser A→B switch / bfcache / in-flight account change not the P5 completion gate. Hosted LOGIN-backed UI: **not** done |
| **P6** | Admin dry-run provision/remove. QQ admin `/api/auth/me` previously **200** `role=admin`. Four report files exist | Official `--apply` create/delete needs `SUPABASE_SECRET_KEY` (still absent). Delete remains dry-run (do not delete admin). Backup/restore, advisors-as-launch-gate, open registration: **not** done |

## User blockers

1. `SUPABASE_SECRET_KEY` still absent for official admin `--apply`.
2. Live cutover: do not point generation-compose `DATABASE_URL` at hosted until an explicit operator cutover. Classroom FORCE RLS remains refused while the shared `anon:` pile exists.
3. Direct hosted DB DNS still fails here; operator LOGIN URLs stay on Session pooler in gitignored env only.
4. DMARC/alignment for `auth.zhiyulearn.online`. `zhiyulearn.online` website not live.

Do not mark the Goal complete.
