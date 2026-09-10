# Production PostgreSQL and authentication

## Summary

OpenMAIC needs one production PostgreSQL source of truth, but it does not need a second PostgreSQL instance solely for user registration and login. The existing Docker PostgreSQL, Neon, and Supabase are alternative PostgreSQL deployments. The application and generation worker use whichever instance `DATABASE_URL` identifies.

## Verified project facts

- The Docker Compose stack defines an optional PostgreSQL 16 service with a persistent `openmaic-postgres` volume: [`docker-compose.yml`](../../docker-compose.yml#L31).
- The server creates PostgreSQL-backed runtime, document, and asset stores from `DATABASE_URL`: [`lib/persistence/server-provider.ts`](../../lib/persistence/server-provider.ts#L42).
- The current browser-visible persistence token is explicitly development-only and provides neither confidentiality nor per-user isolation. Production must verify a real server-side session and derive identity from trusted claims: [`lib/persistence/server-auth.ts`](../../lib/persistence/server-auth.ts#L1).
- Course and folder storage already contains `owner_id` columns and owner-scoped query support: [`packages/@openmaic/storage/src/document/pg.ts`](../../packages/@openmaic/storage/src/document/pg.ts#L43).
- The application uses PostgreSQL `LISTEN/NOTIFY` for low-latency event delivery, with polling retained as a correctness fallback: [`app/api/agent/owner-events/route.ts`](../../app/api/agent/owner-events/route.ts#L28).
- The generation system persists jobs, leases, attempts, events, assets, and worker heartbeats in PostgreSQL: [`lib/server/generation-jobs/migrations.ts`](../../lib/server/generation-jobs/migrations.ts#L8).

## Supabase production-security findings

- Supabase uses a shared-responsibility model: it secures the hosted platform, while the application owner remains responsible for access policies, secrets, account controls, and application logic ([official shared-responsibility model](https://supabase.com/docs/guides/deployment/shared-responsibility-model)).
- Supabase documents encryption at rest and in transit, but production direct-database access should explicitly enable SSL Enforcement and verify server certificates ([SSL Enforcement](https://supabase.com/docs/guides/platform/ssl-enforcement)).
- Authenticated API access relies on PostgreSQL roles, grants, and Row Level Security. Exposed tables need tested RLS policies; tables or views configured incorrectly can expose data ([RLS guide](https://supabase.com/docs/guides/database/postgres/row-level-security), [database security guide](https://supabase.com/docs/guides/database/secure-data)).
- Supabase secret and `service_role` keys bypass RLS and must remain exclusively in trusted server environments; they must never be embedded in `NEXT_PUBLIC_*` values or browser code ([API key guide](https://supabase.com/docs/guides/getting-started/api-keys)).
- Paid plans provide managed database backups with plan-dependent retention, while point-in-time recovery is a separate option. Database backups do not contain the stored file objects in Supabase Storage, so file recovery needs its own design ([backup guide](https://supabase.com/docs/guides/platform/backups)).
- Production password authentication should use email confirmation, appropriate password requirements, rate limits, CAPTCHA, MFA where justified, and a custom production SMTP provider ([password security](https://supabase.com/docs/guides/auth/password-security), [MFA](https://supabase.com/docs/guides/auth/auth-mfa), [CAPTCHA](https://supabase.com/docs/guides/auth/auth-captcha), [SMTP](https://supabase.com/docs/guides/auth/auth-smtp)).
- Supabase publishes a production checklist covering security, performance, availability, and operational readiness ([production checklist](https://supabase.com/docs/guides/deployment/going-into-prod)).

## Recommendation

For this application, a dedicated managed production Supabase project is a reasonable default. Keep the Docker PostgreSQL instance for local development, use separate development and production projects, replace the repository's development-only persistence token with verified Auth sessions, scope every request to the server-derived user ID, and test authorization failures before migration. Use direct or session-pooled PostgreSQL connections for the long-running worker and `LISTEN/NOTIFY` paths.

## OpenMAIC-to-Supabase compatibility audit

### Compatible database features

Supabase provides a full PostgreSQL database rather than a proprietary database abstraction ([database overview](https://supabase.com/docs/guides/database/overview)). OpenMAIC's use of JSONB, foreign keys, transactions, PL/pgSQL trigger functions, `BYTEA`, transaction-scoped advisory locks, identity columns, and row locks is therefore broadly portable. PostgreSQL explicitly documents `FOR UPDATE SKIP LOCKED` as useful for queue-like multi-consumer access ([PostgreSQL `SELECT`](https://www.postgresql.org/docs/current/sql-select.html)).

### Required deployment decisions

- The dedicated OpenMAIC `LISTEN` client is connection-scoped: [`lib/server/agent-runtime/event-notify-bus.ts`](../../lib/server/agent-runtime/event-notify-bus.ts#L240). It must use a Supabase direct connection or Supavisor session mode, not transaction mode. Supabase recommends direct connections for long-lived backends and migrations, session mode for persistent IPv4 backends, and transaction mode for transient/serverless traffic ([connection guide](https://supabase.com/docs/guides/database/connecting-to-postgres)).
- If the Next.js API runs in a serverless environment, short queries may use transaction mode, but `LISTEN/NOTIFY` and other session-level features may not. Transaction mode also requires prepared statements to be disabled ([prepared-statements guidance](https://supabase.com/docs/guides/troubleshooting/disabling-prepared-statements-qL8lEL)).
- The current code uses one `DATABASE_URL` for both ordinary pools and the dedicated listener. A robust split deployment should introduce separate pooled and direct/session URLs instead of sending everything through the transaction pooler.
- Connection budgets vary by Supabase compute size and are shared with Supabase services. OpenMAIC currently creates an eight-connection generation pool [`lib/server/generation-jobs/runtime.ts`](../../lib/server/generation-jobs/runtime.ts#L16), an application pool, an asset-collector pool, and a dedicated listener. Pool sizes and replica counts must be budgeted together ([compute and connection limits](https://supabase.com/docs/guides/platform/compute-and-disk)).

### Migration caveats

- Supabase officially supports PostgreSQL migration via `pg_dump`/`pg_restore`; schema and data migration should use direct or session-mode connections, not transaction mode ([migration guide](https://supabase.com/docs/guides/platform/migrating-to-supabase/postgres)).
- Roles/users and every authorization assumption must be recreated and tested. Supabase does not provide unrestricted superuser access, so migrations that require unsupported superuser operations must be changed ([role and superuser guide](https://supabase.com/docs/guides/database/postgres/roles-superuser)). OpenMAIC's audited application schemas do not rely on custom native extensions or superuser-only operations.
- Supabase Auth is not automatically wired to OpenMAIC's `owner_id`. Authentication middleware must map the verified `auth.users.id` to the application's owner scope; Supabase documents using a public profile table referencing `auth.users` ([user-data guide](https://supabase.com/docs/guides/auth/managing-user-data)).
- Existing OpenMAIC tables are unqualified and therefore normally live in `public`. Do not expose them directly through the Data API without correct grants and tested RLS; alternatively move them to a non-exposed application schema and keep all access behind Next.js APIs.

### Binary assets

The database schema can retain `BYTEA` blobs, but large images, audio, and video increase database disk use, WAL, backup size, and restore time. Supabase Storage is an object-storage service with an S3-compatible API and CDN ([Storage guide](https://supabase.com/docs/guides/storage)). For production, keep hashes, metadata, revisions, and references in PostgreSQL while putting large bytes in Supabase Storage or another S3-compatible store. This requires a tested storage adapter/configuration; changing `DATABASE_URL` alone does not move bytes into Storage.

## Verified provider facts

- Neon supplies a standard PostgreSQL connection string suitable for `DATABASE_URL`, and requires TLS. Its pooled hostname uses PgBouncer transaction pooling; `LISTEN` is unsupported there, so session-affine work should use a direct connection. Sources: [Neon manual Vercel connection](https://neon.com/docs/guides/vercel-manual), [Neon connection pooling](https://neon.com/docs/connect/connection-pooling), [Neon security](https://neon.com/docs/security/security-overview).
- Supabase provides a PostgreSQL connection string and offers direct, session-pooler, and transaction-pooler connection modes. Session mode supports session-level features such as `LISTEN/NOTIFY`; transaction mode does not. Sources: [Supabase connection modes](https://supabase.com/docs/guides/database/connecting-to-postgres), [Supabase Postgres.js guide](https://supabase.com/docs/guides/database/postgres-js), [Supabase Postgres access](https://supabase.com/docs/guides/self-hosting/accessing-postgres).
- A Supabase project includes one PostgreSQL database and a separate Auth service that stores identities in the same project database under the `auth` schema. Application profile tables can reference `auth.users`; a second database is unnecessary. Sources: [Supabase architecture](https://supabase.com/docs/guides/getting-started/architecture), [managing user data](https://supabase.com/docs/guides/auth/managing-user-data).
- Supabase's current Next.js server-side guidance uses cookie-backed authentication through `@supabase/ssr`. Source: [Supabase SSR guide](https://supabase.com/docs/guides/auth/server-side/advanced-guide).

## Engineering recommendation

For a first public deployment, use one managed PostgreSQL instance as the production source of truth. Supabase is the shortest path when hosted authentication is also desired; Neon is a good database-only choice paired with a separate authentication solution. Keep the existing Docker PostgreSQL as a local development database.

Whichever provider is selected, replace the development persistence token with real session verification and enforce the authenticated user ID across every persistence route. Do not expose a privileged PostgreSQL connection string to the browser.

Because OpenMAIC uses `LISTEN/NOTIFY` and a long-running generation worker, provide a direct or session-pooled connection for those components. A transaction-pooled/serverless connection may still be useful for short-lived web requests, but the current code has only one `DATABASE_URL`; supporting split connection modes would require a small configuration change.

The local Docker database and the managed database do not synchronize automatically. Before cutover, run schema migrations and, if existing local data must be preserved, migrate it with a controlled PostgreSQL dump/restore. After cutover, only one database should be treated as the writable production authority.
