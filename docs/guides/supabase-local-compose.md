# Supabase localhost compose runbook

`docker-compose.supabase.yml` is the independent local cutover stack. It does
not extend or mutate `docker-compose.persistence.yml`, does not start a local
Postgres server and does not mount the legacy durable application-data volume.
The legacy project remains the rollback source until T8 is accepted.

## Private configuration

Copy `.env.hosted.example` to the gitignored `.env.hosted.local` and fill values
there. The launcher reads `.env.local` first to preserve the existing model,
media and feature configuration, then applies `.env.hosted.local` as the
Supabase-specific override. This does **not** inject either whole file into a
container: the compose file explicitly enumerates its runtime/build allowlist
and intentionally omits the privileged database migration URL, Supabase secret
key and test-account passwords.

All three Storage buckets (assets, materials and classroom snapshots) must
remain private. The S3 access key is a server-only credential; it is not a
`NEXT_PUBLIC_*` value. Both LISTEN variables must use session/direct
connections because transaction pooling cannot preserve LISTEN:

- `DATABASE_LISTEN_URL_APP_WEB` uses the app_web login and wakes the Web
  process's in-memory SSE subscribers.
- `DATABASE_LISTEN_URL` uses the app_worker login and wakes background runners.

Never put the app_worker LISTEN URL in the Web container. Durable event history
and polling remain the recovery path if a lossy notification is missed.

Download the project database CA certificate from Supabase Dashboard's
**Connect → SSL** panel and save it outside tracked source, for example at
`./secrets/supabase-db-ca.crt`. Set the host path in
`SUPABASE_DB_SSL_ROOT_CERT_PATH`. Operator scripts read that file directly;
Compose mounts the same file read-only as `/run/secrets/supabase-db-ca.crt` for
Web, both workers and the aggregate readiness probe. The certificate is not
copied into either image. Hosted connections fail closed if the path is absent,
unreadable or not PEM, and always use the supplied CA with
`rejectUnauthorized=true`. Do not replace this with `sslmode=require` or
`rejectUnauthorized=false`.
[Supabase's SSL guide](https://supabase.com/docs/guides/platform/ssl-enforcement)
likewise requires the downloaded project CA for `verify-full`.

The launcher may receive database URLs containing Dashboard-generated SSL
query parameters. The app removes those parameters before constructing the
Node PostgreSQL client because `pg` otherwise replaces the explicit CA object;
the explicit verified TLS object remains the sole runtime trust configuration.

Web receives only the `app_web` pooled and LISTEN credentials. Workers receive
only the `app_worker` pooled credential plus their dedicated LISTEN URL. Before
T8 cutover, the Web submission and Pro entry paths must therefore be verified
to use owner-bound `app_web` transactions; cross-owner claiming and leases stay
in workers. Do not work around a failed path by adding `WORKER_DATABASE_URL` or
the worker's `DATABASE_LISTEN_URL` to Web.

## Safe phases

Validate interpolation without displaying substituted values:

```powershell
pwsh ./scripts/supabase-compose.ps1 -Action Config -CapacityTier 4
```

Build images during migration, without starting or switching containers:

```powershell
pwsh ./scripts/supabase-compose.ps1 -Action Build -CapacityTier 4
```

If `docker-compose.dns.local.yml` exists, the launcher includes it in every
operation so recreating containers preserves the operator's local DNS setup.
After building, apply the images without another build with `-Action Apply`:

```powershell
pwsh ./scripts/supabase-compose.ps1 -Action Apply -CapacityTier 4 `
  -GenerationMode Background -AcceptJobs -ConfirmWrites
```

`Apply` can recreate Web and workers. Finish or safely drain active work before
using it; `Build` alone leaves running containers unchanged. Hosted pools keep
idle connections for 60 seconds to reuse costly remote TLS handshakes, while
the Web/worker pool limits and 10-second checkout deadline remain enforced.

The Supabase runtime explicitly uses a 90-second Pro lease with a 10-second
heartbeat, matching ordinary generation. A remote checkout alone can consume
the legacy Pro lease's entire 10-second lifetime; the larger window allows
delayed or missed heartbeats without another worker incorrectly taking over.
Web and both workers inherit the same settings so admission and takeover agree.
After a worker stops heartbeating, its session becomes reclaimable after
90 seconds plus the next successful scan; the existing worker-id/attempt fences
still reject writes from the old holder. Sustained database unavailability can
still cause a legitimate lease expiry and should be investigated separately.
The legacy deployment retains its 10-second lease and 2-second heartbeat.

The default start keeps the generation write gate closed. Do not send user
traffic to this verification stack while data migration is active:

```powershell
pwsh ./scripts/supabase-compose.ps1 -Action Start -CapacityTier 4
```

After the migration ledger, owner/reference checks and T8 preconditions pass,
opening generation submission requires two explicit switches. Background mode
is the default and exercises queue/worker generation:

```powershell
pwsh ./scripts/supabase-compose.ps1 -Action Start -CapacityTier 4 `
  -GenerationMode Background -AcceptJobs -ConfirmWrites
```

Ordinary foreground generation has a separate, explicit Web runtime mode. The
launcher refuses to start it without both write confirmations because the
synchronous APIs can write without creating a background job:

```powershell
pwsh ./scripts/supabase-compose.ps1 -Action Start -CapacityTier 4 `
  -GenerationMode Foreground -AcceptJobs -ConfirmWrites
```

Switching modes recreates the Web container environment; workers always remain
in background mode so already queued work can continue. Use different courses
and independent evidence for foreground and background acceptance. A single
background job cannot satisfy both protected-flow checks.

The launcher never stops, removes or adopts the legacy Compose project. If
localhost port 3000 is occupied, startup fails and the operator must resolve the
cutover explicitly. `NEXT_PUBLIC_*` values are Docker build arguments, so a
feature/auth change requires rebuilding the Web image.

## Readiness

Each scaled worker's Docker healthcheck verifies its own database row and recent
heartbeat. The aggregate probe verifies both current pipeline heartbeats,
account and generation schema versions, and authenticated `HeadBucket` access to
the private asset, material and classroom snapshot buckets:

```powershell
pwsh ./scripts/supabase-compose.ps1 -Action Readiness -CapacityTier 4
```

An HTTP 200 from the home page is not readiness. The aggregate probe emits only
booleans, versions and counts; it never emits URLs or credentials.

## T9 capacity ladder

Keep exactly two worker replicas and advance only after the full T8 five-part
regression matrix passes at the preceding tier:

| Tier | Site roots | Per owner | Worker concurrency (each) | Agent max | Global DB limiter |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 4 | 4 | 2 | 2 | 4 | 4 |
| 8 | 8 | 2 | 4 | 8 | 8 |
| 16 | 16 | 2 | 8 | 16 | 16 |

For each tier, record provider throttling, `pg_stat_activity`, pool waits, memory,
event-loop/lease heartbeat behavior and the actual maximum running root count.
Passing the configuration contract does not by itself prove real 4/8/16 load.
At tier 16, repeat all five protected regressions: ordinary foreground,
ordinary background, Pro, full classroom UI, and teach-back history/recovery.

The optional `-VideoExport` profile preserves the MP4 renderer path, but its
standard profile requires 8 GiB by itself. Measure it separately from the
16-root generation load; do not disable the export UI to make capacity pass.
