# Ownership inventory (P0)

Code-level inventory of the 2026-09-19 worktree. **Not** an A/B isolation proof. Confirmed project **zhiyu** (`lzomhnjyymalupgvcato`) now has accounts tables + RLS v1–v4; document/generation tables are still absent. This Docker volume was not migrated.

## Identity

- Canonical user (hosted): Supabase `auth.users.id`
- Application principal: `user:${uuid}` used as `ownerId`, `learnerKey`, and `assetPrincipal`
- Role/status live in `app_accounts`, never in client `user_metadata`
- Browser `x-openmaic-user` / `x-openmaic-session` can only reject mismatched requests
- Legacy: signed `generation_owner` cookie (`anon:{uuid}`) and optional `PERSISTENCE_DEV_TOKEN`

## What binds `app.owner_id` today (hosted only)

These paths call `set_config('app.owner_id', ownerId, true)` on a short transaction. They do nothing extra when `AUTH_MODE` is unset.

| Path | Mechanism |
| --- | --- |
| Persistence documents | `createOwnerBoundDocumentStore` `bindHostedOwner` after `BEGIN` |
| Persistence document access / stage_meta reads | `createOwnerBoundQueryable` in `handlePersistenceRequest` |
| Persistence runtime + asset HTTP stores | `createHostedOwnerBoundStores` → `createOwnerBoundQueryable` (not the shared singleton stores) |
| Hosted `/api/kv` | `createOwnerBoundQueryable` |
| Hosted `resolveServerAsset` | `createHostedOwnerBoundStores` after `requirePrincipal` |

`createOwnerBoundQueryable` is the shared helper. Instances must not be cached across HTTP requests.

## Hosted process-role pool split

| Connection | Legacy (`AUTH_MODE` unset) | Hosted (`AUTH_MODE=supabase`) |
| --- | --- | --- |
| Persistence HTTP / KV / profiles | `DATABASE_URL` | `DATABASE_URL` should be `app_web` + owner-bound queryable |
| Generation HTTP/readiness | `DATABASE_URL` | owner-bound `DATABASE_URL` (`app_web`) plus aggregate SECURITY DEFINER seams |
| Generation worker / collector | `DATABASE_URL` | `WORKER_DATABASE_URL` (`app_worker`) |
| Web SSE LISTEN | shared `DATABASE_URL`/`DATABASE_LISTEN_URL` | `DATABASE_LISTEN_URL_APP_WEB` (`app_web`, session/direct) |
| Worker runner LISTEN | shared `DATABASE_URL`/`DATABASE_LISTEN_URL` | `DATABASE_LISTEN_URL` (`app_worker`, session/direct) |
| Pro request stores / snapshots | `DATABASE_URL` singleton | owner-bound `DATABASE_URL` (`app_web`) |
| Pro runner stores / snapshots | `DATABASE_URL` singleton | `WORKER_DATABASE_URL` (`app_worker`) |

The two hosted LISTEN URLs carry different login roles even when both use the
same Supabase session-pooler host. Web never receives the worker URL.

## Still a shared high-priv pool (this stack)

| Path | Why |
| --- | --- |
| `getServerPersistenceProvider` singleton | schema ensure, Pi composition, **legacy** runtime/asset stores |
| Generation worker / job repository | cross-owner claim, fencing, heartbeats — must see all jobs (`app_worker` after cutover) |
| Pro runner system stores | scheduler, not the browser |
| `/api/admin/status` account count | admin aggregate; not owner-scoped |

## Bytes backend

| Mode | When | Isolation |
| --- | --- | --- |
| PostgreSQL BYTEA | default / this Docker stack (`ASSET_S3_BUCKET` forbidden by compose) | registry `asset_entries.principal`; blob table has no owner column. Hosted v2 **drops** open `app_web` INSERT on `asset_blobs`. |
| `LocalAssetByteStore` | `ASSET_BYTE_BACKEND=local` + `ASSET_LOCAL_ROOT` | files on disk; path is not an ACL. **Not** the running compose mode. Do not flip the live stack. |
| S3 | `ASSET_S3_BUCKET` | not used on this stack |

`withLegacySharedAssetReads` only wraps the **shared** provider for background generation + `anon:` principals. Hosted stores from `createHostedOwnerBoundStores` do not use that proxy. Hosted bootstrap also skips legacy browser asset fallback.

## Tables / files (application checks)

| Family | Field | Isolation in app code | SQL layer |
| --- | --- | --- | --- |
| `document_stages`, `stage_meta`, folders | `owner_id` | hosted reads require matching owner (`decideDocumentAccess`, owner-bound document store). Chat/agent/learning POST uses `refuseForeignStagePost`: signed-in `user:` 404s on foreign and unsigned-library stages; unsigned may still chat the live `anon:` pile; existing-course attach requires an owned live row | RLS SQL in repo, unapplied |
| scenes/outlines/revisions | parent stage | via parent | RLS SQL in repo, unapplied |
| runtime sessions/records | `learner_key` | store + hosted bound queryable on persistence HTTP | RLS SQL in repo, unapplied |
| assets | `principal` | hash is not an ACL; hosted asset store is owner-bound | blob INSERT tightened in migration v2, unapplied |
| generation jobs and children | `owner_id` | job protocol / `withGenerationRequest` | worker policies are cross-owner by design |
| Pro sessions/skills/connections/snapshots | `owner_id` | stores load/sync/revoke by `owner_id`; HTTP uses `withRequestOwnerId` / `withGenerationRequest` (`user:{uuid}` in dual-mode). Foreign modelRef/snapshot is unavailable (409), not readable | RLS SQL in repo, unapplied |
| `classroom` JSON under `data/classrooms` | `ownerId` | no cross-user overwrite; GET uses `classroomOwnerAllows` | files, not PG |
| classroom media files | parent classroom | `classroomMediaAllows`: `user:` snapshot 404 for B and unsigned; missing snapshot stays unsigned/legacy; hosted `private, no-store` | files |
| usage JSONL | `ownerId` | signed-in GET exact owner; unsigned hides `user:` rows and still sees unowned legacy | files |
| render jobs | `data/render-jobs/{id}.json` | poll/download/cancel owner map | files |
| `account_kv` | `owner_id` | hosted API + bound SQL | RLS SQL in repo, unapplied |

## Client caches

- Hosted KV namespace: `zhiyu:openmaic:{userId}`
- Hosted persistence does not fall back to shared/legacy browser assets
- Sign-out freezes an auth epoch, clears the session, broadcasts other tabs, full reload

## Historical data

Anonymous `anon:*`, `shared`, and empty-owner rows stay unreadable in hosted mode. They are not auto-claimed on first login.
