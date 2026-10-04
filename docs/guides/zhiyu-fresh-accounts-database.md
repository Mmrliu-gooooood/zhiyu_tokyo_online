# Fresh accounts database (disposable or staging)

How to build a new hosted-shape database up to the latest accounts version.
**Never production.** Production (Supabase `lvbtgwlsebzbtcvjwktq`) gets new
accounts versions one at a time, applied by hand with their checksum row; never
run `pnpm accounts:migrate` or this bootstrap against it.

## Why `pnpm accounts:migrate` cannot do it

On a fresh database where the base schemas already exist (as
`generation:migrate` creates them), `migrateAccountsSchema` stops at v8:

```
policy "document_stages_web_insert" for table "document_stages" already exists (42710)
```

v1 creates the `document_stages` and `generation_jobs` owner policies when those
tables exist, and v8 re-creates some of them without `DROP POLICY IF EXISTS`.
Production never hit this: v1–v4 ran before the tables existed, and v5–v7 are
classroom-only, so production never recorded them. The migration SQL cannot be
fixed in place, because production `app_schema_migrations` holds its checksums.

## The bootstrap

`pnpm accounts:bootstrap-fresh` (`lib/server/accounts/fresh-bootstrap.ts`)
replays production's order in one transaction:

1. accounts v1–v4
2. base schemas, in `workers/generation/migrate.ts` order
3. `FORCE ROW LEVEL SECURITY` on `document_stages`, `stage_meta` and `generation_jobs`
4. drop the five v1 policies that v8 re-creates unguarded (only present when the
   base tables existed before v1)
5. accounts v8 through the latest version

Versions 5–7 are left unapplied, as in production. It works whether or not the
base schemas already exist, and both starting points end in the same schema
(see `tests/server/accounts-fresh-bootstrap.test.ts`).

It refuses to run on:

- the production project (any URL that mentions its project ref)
- the classroom database `openmaic`
- a database that already records an accounts version
- a database whose `app_accounts`, `document_stages`, `stage_meta`, `generation_jobs` or
  `agent_sessions` has rows

```bash
ACCOUNTS_BOOTSTRAP_DATABASE_URL=postgres://proof_admin@127.0.0.1:55432/my_stack_rls_proof pnpm accounts:bootstrap-fresh --confirm-database=my_stack_rls_proof --stub-supabase-auth
```

- `--confirm-database` must repeat the database name from the URL.
- `--stub-supabase-auth` is for plain PostgreSQL only. It creates the Supabase
  Auth objects the accounts SQL references (`anon`, `authenticated`,
  `auth.users`, `auth.sessions`, `auth.uid()`), but only those that are missing.
  Leave it off on a Supabase staging project.
- For TLS to a remote staging database, add `?sslmode=require` (or stricter) to
  the URL.

The bootstrap does not create the hosted LOGIN roles (`zhiyu_app_web`,
`zhiyu_app_worker`) or any accounts.

## Later versions

A bootstrapped database matches production's history. Apply later versions the
way production does: run the version's SQL and insert its checksum row. You can
also bootstrap a new disposable database. Do not run `pnpm accounts:migrate` on
it, because that would also apply v5–v7.

## Test

```bash
docker compose -p openmaic-accounts-rls-proof -f docker-compose.accounts-rls-proof.yml up -d --wait
```

```bash
TEST_ACCOUNTS_BOOTSTRAP_DATABASE_URL=postgres://proof_admin@127.0.0.1:55432/accounts_rls_proof pnpm vitest run tests/server/accounts-fresh-bootstrap.test.ts --maxWorkers=4
```

Without the variable, the test runs on PGlite only. With it, each case creates
and drops its own `fresh_bootstrap_*_rls_proof` database on the disposable
server.
