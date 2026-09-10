# Cloudflare versus Supabase for OpenMAIC

## Summary

Cloudflare cannot replace the project's PostgreSQL and Supabase Auth boundary as a drop-in change. It can replace or augment hosting, edge security, object storage, and background-processing components. Replacing PostgreSQL with D1 would require a substantial data-access and concurrency redesign.

## Verified project requirements

- OpenMAIC uses PostgreSQL JSONB and PostgreSQL casts/functions throughout its persistence schemas: [`document/pg.ts`](../../packages/@openmaic/storage/src/document/pg.ts#L76), [`generation-jobs/migrations.ts`](../../lib/server/generation-jobs/migrations.ts#L8).
- The generation queue uses PostgreSQL row locks and `FOR UPDATE SKIP LOCKED`: [`generation-jobs/repository.ts`](../../lib/server/generation-jobs/repository.ts#L398).
- Coordination uses PostgreSQL transaction advisory locks: [`generation-jobs/repository.ts`](../../lib/server/generation-jobs/repository.ts#L218).
- Agent event delivery owns a dedicated, connection-scoped PostgreSQL `LISTEN` client: [`event-notify-bus.ts`](../../lib/server/agent-runtime/event-notify-bus.ts#L240).
- The asset schema can store binary media in PostgreSQL `BYTEA`: [`asset/pg.ts`](../../packages/@openmaic/storage/src/asset/pg.ts#L64).

## Cloudflare capability mapping

| OpenMAIC need | Cloudflare product | Compatibility |
|---|---|---|
| PostgreSQL relational store | D1 | Not drop-in. D1 uses SQLite semantics, not PostgreSQL ([D1 SQL](https://developers.cloudflare.com/d1/sql-api/sql-statements/)). |
| Existing external PostgreSQL access | Hyperdrive | Connects Workers to an existing PostgreSQL/MySQL database; it is not a database ([Hyperdrive PostgreSQL example](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/)). |
| Large media objects | R2 | Good replacement for the binary-object layer; R2 is S3-compatible and strongly consistent ([R2 overview](https://developers.cloudflare.com/r2/how-r2-works/), [S3 API](https://developers.cloudflare.com/r2/api/s3/api/)). |
| Durable background dispatch | Queues / Workflows | Capable alternative infrastructure, but adopting it means replacing the existing PostgreSQL job/lease protocol ([Queues](https://developers.cloudflare.com/queues/), [Workflows](https://developers.cloudflare.com/workflows/)). |
| End-user registration/login | Access / Turnstile | Not equivalent to Supabase Auth. Access is an application access-control layer built around identity providers; Turnstile protects forms from bots ([Access identity providers](https://developers.cloudflare.com/cloudflare-one/identity/idp-integration/), [Turnstile login forms](https://developers.cloudflare.com/turnstile/tutorials/login-pages/)). |

## Incompatibilities that force a rewrite

- D1 stores JSON using SQLite-compatible representations and does not provide PostgreSQL JSONB syntax or casts ([D1 JSON queries](https://developers.cloudflare.com/d1/sql-api/query-json/)).
- D1 does not provide PostgreSQL `LISTEN/NOTIFY`, advisory locks, or the current `FOR UPDATE SKIP LOCKED` coordination semantics. D1's concurrency and size limits follow a different SQLite-backed execution model ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/)).
- D1 supports blobs, but its per-value/per-row limits make it unsuitable for moving the current media-byte rows unchanged; large objects belong in R2 ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/)).
- Hyperdrive does not support PostgreSQL advisory locks or `LISTEN/NOTIFY`, so the current listener/coordination paths still need a direct PostgreSQL connection ([Hyperdrive feature support](https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/)).

## Recommendation

For the first production release, use a hybrid architecture: Supabase PostgreSQL and Supabase Auth as the system of record and identity provider; Cloudflare DNS/CDN/WAF in front of the application; and optionally R2 for media objects. Keep the generation worker and PostgreSQL event listener on direct/session PostgreSQL connections. Consider Queues or Workflows only as a later, deliberate job-system redesign.

A Cloudflare-first architecture using D1, R2, Queues/Workflows, and a separate authentication provider is technically possible, but it is a platform migration rather than a database substitution.
