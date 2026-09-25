# Hosted accounts — migration record

## Hosted accounts v10 (2026-09-20, authoritative current state)

Applied only to confirmed project **zhiyu** (`lzomhnjyymalupgvcato`) as Supabase migration `accounts_v10_agent_pro_rls` (`20260920093321`). Repo migration version **10** is recorded in `app_schema_migrations` with checksum **`cbec0f77c676d2c1161cfd54fde1bebf890636d2c37211012faa3b05c59f84b4`**.

The migration installs the actual Agent/Pro runtime tables used by this worktree: `agent_sessions`, `agent_session_events`, `agent_session_entries`, `agent_owner_session_events`, `agent_user_skill`, `agent_session_materials`, `pro_model_connections`, and `pro_model_connection_revisions`. All eight have RLS enabled and forced, one owner-aware `app_web` policy and one `app_worker` policy, DML grants only for those application roles (plus platform owner/service roles), and no direct `anon` or `authenticated` table grants. `app_profiles` also has the owner-bound insert policy required by the profile upsert.

Post-proof cleanup: `document_stages=0`, `generation_jobs=0`, `agent_sessions=0`, `agent_session_materials=0`, `owner_material=0`; `app_accounts=3`. This is a hosted test schema only. The classroom database, its 115 anonymous course rows, and its migration versions 6+7 were not changed.

Date: 2026-09-19. Project **zhiyu** ref `lzomhnjyymalupgvcato` is **confirmed**. `zhiyulearn.online` is owned but **not** deployed; do not treat it as the live Site URL.

## Local SQL (in repository)

- `lib/server/accounts/sql-accounts.ts` version 1: `app_internal`, `app_web` / `app_worker` (`NOBYPASSRLS`, no LOGIN), account/profile/kv/classroom/render/usage/audit tables, Auth trigger (role always `user`).
- `sql-rls.ts` v1: enable RLS, revoke `anon`/`authenticated`, owner policies. Policies on document/generation tables are skipped when those tables do not exist (`to_regclass`).
- v2: drop open `asset_blobs` insert if the table exists; revoke ALL TABLES from `app_worker`; listed DML grants (account tables ungated).
- v3: revoke `EXECUTE` on `public.rls_auto_enable()` from `PUBLIC` / `anon` / `authenticated`.
- v4: `app_worker` `FOR ALL` policies on tables that exist; Pro/agent web policies skipped until those tables exist.
- v5: `public.reserved_admin_lifecycle_snapshot(email)` — authenticated reserved admin can read their own session ids and owned-row counts (no tokens). Repo checksum `567b650a0e493772a2fc0d406d3f1bb59c4b4b0df2d1b1429d1b28511ea84a8b`. Function is on hosted; `app_schema_migrations` still has v1–v4 until a later hosted `accounts:migrate`.
- Apply with `pnpm accounts:migrate` using `GENERATION_MIGRATION_DATABASE_URL` or `DATABASE_URL`. Checksum in `app_schema_migrations`.

## Remote Supabase — before (read-only)

- `ACTIVE_HEALTHY`, `ap-southeast-1`, Postgres 17.6.1.166
- API URL: `https://lzomhnjyymalupgvcato.supabase.co`
- Application migrations: **none**
- `public` / `app_internal` tables: **none**; `auth.users` = 0
- Security advisors: `public.rls_auto_enable()` executable by `anon`/`authenticated`

## Remote Supabase — after MCP apply (2026-09-19)

No user or business rows existed; apply did not overwrite data. `auth.users` remained **0**.

### `app_schema_migrations` (repo checksums)

| version | checksum |
| --- | --- |
| 1 | `63a43e9e5cc9794c3147439b9956c3392ed54bdc424f72124e88b94db231cadb` |
| 2 | `ba20d3e470d8496e002a09f0f2b90cd611ef61108265970cde1484a6216a95b6` |
| 3 | `768d735cb7b526e9e3671fa362330b15bc8ea8c0d96f32b0946fc7db43ce1244` |
| 4 | `21e1ef91e078a7df9f99cb3a1a5c3acb52012d9a931327206483e9898cfd0e7f` |

### Supabase `list_migrations`

| version | name |
| --- | --- |
| 20260919091326 | `accounts_v1_schema_and_rls` |
| 20260919091352 | `accounts_v1_rls_existing_tables` |
| 20260919091406 | `accounts_v3_revoke_rls_auto_enable` |
| 20260919091522 | `accounts_v4_worker_rls_policies` |
| 20260919091524 | `accounts_v2_worker_grants` |

### Tables now in `public` (RLS on, 0 rows)

`app_accounts`, `app_profiles`, `account_kv`, `classroom_snapshots`, `render_job_owners`, `usage_events`, `admin_audit_events`, `app_schema_migrations`

Roles: `app_web` and `app_worker` exist, `rolbypassrls=false`, **`rolcanlogin=false`**. LOGIN inheritors `zhiyu_app_web` / `zhiyu_app_worker` were added later (`LOGIN`, `INHERIT`, `NOBYPASSRLS`). Operator still must apply passwords locally (Dashboard Connect / SQL Editor), not via MCP. Do not put passwords in git.

Security advisors after apply: `rls_auto_enable` anon/authenticated findings are **gone**. Remaining INFO: `app_schema_migrations` has RLS and no policies (intentional; Data API should not read it).

Document/generation/runtime/agent tables were **not** created (accounts SQL only). Their owner policies will appear only after that schema exists **and** the ensure/policy SQL is run again. Because checksums 1–4 are already recorded, a later `pnpm accounts:migrate` will **skip** v1–v4. After generation schema lands, add a new accounts version (or an explicit ensure apply) — do not assume isolation is complete.

## Still operator Dashboard / secrets (not done)

1. Auth Site URL **now**: `http://localhost:3000` plus confirm/recovery allow-list. See [zhiyu-resend-smtp.md](../guides/zhiyu-resend-smtp.md).
2. Resend account, verified sending-domain DNS, Dashboard SMTP fields. No API key exists in this repo.
3. LOGIN passwords for `zhiyu_app_web` / `zhiyu_app_worker` in gitignored `.env.hosted.local` (`DATABASE_URL_APP_WEB` / `WORKER_DATABASE_URL`). Roles **exist**; passwords were generated locally but **not applied** until Dashboard Connect / SQL Editor. Do not put passwords in git.
4. Publishable key is in gitignored `.env.hosted.local`. `SUPABASE_SECRET_KEY` is still absent (MCP has no secret-key tool; CLI not logged in).
5. Test admin mailbox `2470034737@qq.com` (`64b61f8a-79d3-447a-9531-fb5deafd7527`, confirmed, `role=admin`). Official dry-run provision/remove succeed via self-snapshot. Official `--apply` create/delete still need `SUPABASE_SECRET_KEY`. Password not in git.
6. Ordinary signup A: `lzg0724aaa@163.com` (`09ee0532-7110-4bd4-ae73-e95f4d5126b0`, confirmed, `role=user`, display name `learner`). Confirm click used the default implicit hash, not `token_hash`. Account B: `zhigngliu0724@gmail.com` (`fdef1b67-298d-40c9-bc60-d778816ea1c6`, confirmed, `role=user`).

SMTP cannot be configured from this repository. Hosted email is **not** production-ready.

## This turn (local throwaway only)

Accounts SQL v1–v4 were also applied to disposable Compose project `openmaic-accounts-rls-proof` (`accounts_rls_proof` on `127.0.0.1:55432`), proved as `app_web`, then `down -v`. That database is gone. Live `openmaic-main_openmaic-postgres` was not migrated. This turn did not apply further SQL to remote zhiyu.

## Classroom session registry (live Docker PG, 2026-09-19 follow-up)

Live `postgres:5432/openmaic` had no `app_internal`, so `/api/auth/me` previously skipped the registry (`3F000` / `AUTH_UNAVAILABLE`). Full v1–v4 was **not** applied (would FORCE RLS on 115 `anon:` `document_stages` rows).

### Landed on classroom PG (v6 only)

Checksum `c1750945c5c70c59e910429b72c0026bd134529e8074409b4a685a632247b747`. `app_schema_migrations` has version **6** only.

| Object | Notes |
| --- | --- |
| `app_internal` | schema |
| `app_internal.current_owner_id()` | `app.owner_id` GUC |
| `app_internal.session_is_active(uuid, uuid)` | checks `auth.sessions` when present; **true** when Auth catalog is absent |
| `app_internal.ensure_account(uuid, text)` | inserts `app_accounts`/`app_profiles` with `role=user` |
| `app_accounts`, `app_profiles` | RLS **off** (not Data API) |
| `app_web` / `app_worker` | `NOLOGIN`, `NOBYPASSRLS` |

### Skipped on classroom PG

- accounts v1–v5 (v1 bundles FORCE RLS on `document_stages` when the table exists)
- `ENABLE` / `FORCE ROW LEVEL SECURITY` on `document_stages`, `stage_meta`, `generation_jobs`
- extra v1 tables (`account_kv`, `classroom_snapshots`, `render_job_owners`, `usage_events`, `admin_audit_events`)
- Auth trigger / `auth.users` FK (no `auth` schema on classroom)
- hosted generation schema on remote zhiyu
- hosted accounts v6 (live stack uses classroom `DATABASE_URL`)

Post-apply: `document_stages` 115 rows, all `anon:`; `generation_jobs` 56; RLS/FORCE still **off**. Operator path: `pnpm accounts:migrate-classroom-registry` (`CLASSROOM_SESSION_REGISTRY_MIGRATE=1`) or `--print-apply-sql` piped to classroom `psql`. `pnpm accounts:migrate` refuses FORCE RLS on this database.

## Classroom role sync (live Docker PG, 2026-09-19 later)

Accounts **v7** landed on classroom PG only (`ensure_account` upsert of hosted `role`/`status`). Checksum `0ba640203aa87c806444476bc6b7a335578012d25e095959e99a0581412f57b7`. Version **6** checksum unchanged. Generation tables still `rls=f` / `force_rls=f`, **115** `anon:` stages.

Hosted Data API (not classroom PG): migration `app_accounts_authenticated_self_select` grants `authenticated` SELECT of own `app_accounts` row via `auth.uid()`. No `SUPABASE_SECRET_KEY`. Hosted `document_stages` did not exist **yet** in that pass (empty FORCE RLS tables landed later). Hosted `app_accounts` still **1 admin + 2 users**.

## Hosted generation RLS skeleton (2026-09-19 later)

Applied **only** on confirmed project `lzomhnjyymalupgvcato` (database `postgres`, not classroom `openmaic`). Live generation-compose `DATABASE_URL` was **not** pointed at hosted. Classroom `document_stages` was **not** FORCE RLS’d.

Repo accounts **v8** (`ACCOUNTS_MIGRATION_8` + `ACCOUNTS_RLS_SQL_V8`): creates the minimum document/generation tables existing `app_web` owner policies expect (`IF NOT EXISTS`, empty of course rows), then ENABLE + **FORCE RLS** + owner policies for those tables only. Does **not** REVOKE the `authenticated` column self-select on `app_accounts`. Refuses `current_database() = 'openmaic'` and any `document_stages` that already has rows. `pnpm accounts:migrate` still refuses FORCE RLS when classroom generation tables exist without FORCE.

Checksum `b4d86d19fe7101bca673dab8e3c6377ba26dfc0a2148f6c2ce23f0ce0e45b78e` recorded in hosted `app_schema_migrations` version **8**. Versions 1–4 unchanged. v5–v7 are **not** in hosted `app_schema_migrations` (v6/v7 remain classroom-only).

### Supabase `list_migrations` added

| version | name |
| --- | --- |
| 20260919160900 | `hosted_generation_min_tables` |
| 20260919161132 | `hosted_generation_force_rls_app_web` |

### Hosted `public` after

Account tables unchanged: **3** `app_accounts` rows (admin + A + B). Generation/document tables exist with **0** rows. `document_stages` / `stage_meta` / `generation_jobs` `rls=t` / `force_rls=t`. `anon` / `authenticated` cannot SELECT `document_stages`. `authenticated` still has column SELECT on `app_accounts` (`user_id`, `owner_id`, `role`, `status`).

This is an RLS skeleton, not a full generation-schema cutover (no worker claim protocol, no live `DATABASE_URL` switch).

### Classroom Postgres (untouched)

`openmaic`: `document_stages` **115** (`115` `anon:`, `0` `user:`), `stage_meta` live `anon:` **51**, tombstoned **64**. `document_stages` / `stage_meta` / `generation_jobs` still `rls=f` / `force_rls=f`. `app_schema_migrations` versions **6** and **7** only.

## Hosted role-membership hygiene (2026-09-20)

Goal stays **ACTIVE**. Admin was not deleted. Classroom was not FORCE RLS’d. Live `DATABASE_URL` was not changed. This hygiene pass did not create LOGIN passwords (roles already existed).

A prior SET ROLE proof `GRANT app_web TO postgres` had been followed by `REVOKE app_web FROM postgres`, but `pg_auth_members` still listed `postgres` on `app_web`. This pass confirmed the leftover is **not** that proof grant.

### Membership before (MCP `postgres`, read-only)

| Role | Member | login | admin | inherit | set | grantor |
| --- | --- | --- | --- | --- | --- | --- |
| `app_web` | `postgres` | true | true | false | false | `supabase_admin` |
| `app_web` | `zhiyu_app_web` | true | false | true | true | `postgres` |
| `app_worker` | `postgres` | true | true | false | false | `supabase_admin` |
| `app_worker` | `zhiyu_app_worker` | true | false | true | true | `postgres` |

`pg_has_role('postgres', 'app_web'/'app_worker', 'MEMBER')` = **true**; `'USAGE'` = **false**; `'SET'` = **false**. `postgres` is **not** a superuser (`rolsuper=false`) and **cannot** `SET ROLE supabase_admin`. Intended NOLOGIN roles `app_web` / `app_worker` remain `NOLOGIN`, `NOINHERIT`, `NOBYPASSRLS`.

### Revoke

Revoke **was needed** (direct `pg_auth_members` rows for `postgres` on both roles). Ran:

- `REVOKE app_web FROM postgres;` and `REVOKE app_worker FROM postgres;` — completed without error; **no-op** against the `supabase_admin` grants (MCP `postgres` is not the grantor and is not a superuser).
- `REVOKE … GRANTED BY supabase_admin` — **failed** `42501` permission denied (only `supabase_admin` may revoke those grants).

No `CASCADE` (would drop the intended `zhiyu_app_web` / `zhiyu_app_worker` memberships granted by `postgres`). Those LOGIN inheritors were left in place. No other unexpected members of `app_web` / `app_worker`.

### Membership after

**Unchanged** from the before table. `postgres` remains a direct member of `app_web` and `app_worker` with `ADMIN` / `NOINHERIT` / `NO SET`, grantor `supabase_admin`.

### Counts (unchanged)

| Probe | Result |
| --- | --- |
| Hosted `app_accounts` | **3** (1 `admin` + 2 `user`) |
| Hosted `auth.users` | **3** |
| Hosted `document_stages` | **0** |
| Classroom `openmaic` `document_stages` | **115** (`115` `anon:`, `0` `user:`) |
| Classroom `stage_meta` | live `anon:` **51**, tombstoned **64** |
| Classroom generation RLS / FORCE | `f` / `f` |
| Classroom `app_schema_migrations` | **6** and **7** only |

Removing the leftover `postgres` membership requires a `supabase_admin` session (Dashboard SQL as that role, not MCP `postgres`). Do not `CASCADE`.

## Hosted LOGIN passwords (2026-09-20, applied via Session pooler)

Goal stays **ACTIVE**. Admin was not deleted. Classroom was not FORCE RLS’d. Live `DATABASE_URL` was not changed. No Docker rebuild.

Operator Session pooler URI was stored only as gitignored `HOSTED_DB_ADMIN_URL` (user `postgres.<ref>`, host `aws-0-ap-southeast-1.pooler.supabase.com:5432`). `pnpm accounts:apply-hosted-logins` **ok** (`zhiyu_app_web` / `zhiyu_app_worker` connect). LOGIN isolation as `zhiyu_app_web`: A **1**, B **0**, leftover **0**. Data API still `anon` **401** / `authenticated` **403** (`42501`). Privileged `document_stages` count **0**.

## Classroom app-layer isolation (2026-09-20, live Docker `openmaic`)

No accounts SQL version. No FORCE RLS. Live `DATABASE_URL` unchanged (classroom `postgres:5432/openmaic`). Hosted schema unchanged. After disposable A fixtures were deleted: `document_stages` **115** `anon:` / **0** `user:`; `generation_jobs` **56** all `anon:`; RLS/FORCE `f`/`f`; `app_schema_migrations` still **6** and **7** only.

## Classroom chat POST / Pro modelRef (2026-09-20, live Docker `openmaic`)

No accounts SQL version. No FORCE RLS. Live `DATABASE_URL` unchanged. Anonymous library owners not rewritten. After disposable A stage + dummy `pro_model_connections` rows were deleted: `document_stages` **115** `anon:` / **0** `user:`; live `stage_meta` `anon:` **51**; RLS/FORCE `f`/`f`; `app_schema_migrations` still **6** and **7** only. Docker images `05b86be8…` / `64ed3f61…`, revision `worktree-3e8714f653ad-4dd271d45f24b1ca`.

## Hosted accounts v9 (2026-09-20, hosted PG only)

Applied only because hosted `document_stages` / `generation_jobs` / `generation_ownership` were **empty**. Refused classroom `openmaic`. Checksum **`c1a99b3b9768ec233b2b677ff2808c8ab4e5cdb424c3d6bc34a36ae888f01927`**. Real `generation_jobs` (uuid + `idempotency_key`) and `generation_ownership(stage_id)`. FORCE RLS remains **on** hosted generation tables. `app_accounts` **3**. LOGIN `zhiyu_app_web` proof: A **1**, B **0**, leftover **0**. Live classroom still migrations **6**+**7**, RLS/FORCE **off**, **115** `anon:` stages. This is **not** a DATABASE_URL cutover.

## Hosted accounts v9 (2026-09-20, hosted postgres only)

Applied only on project `lzomhnjyymalupgvcato`. Refuses `current_database() = 'openmaic'` and non-empty `document_stages`. Checksum prefix `c1a99b3b9768` in hosted `app_schema_migrations` version **9**. Versions 1–4 and 8 unchanged. v5–v7 remain classroom-only.

Hosted `generation_jobs.id` is uuid with `idempotency_key`. `document_stages` / `generation_jobs` / `generation_ownership` / `stage_meta` still `rls=t` / `force_rls=t` and **0** rows after LOGIN + API fixture cleanup. `app_accounts` still **3**. Classroom `openmaic` still versions **6** and **7** only, **115** `anon:` stages, RLS/FORCE **off**.

Independent compose `openmaic-hosted` (`127.0.0.1:3001`) uses LOGIN URLs + `ASSET_BYTE_BACKEND=local`. It is not the live generation-compose stack.
