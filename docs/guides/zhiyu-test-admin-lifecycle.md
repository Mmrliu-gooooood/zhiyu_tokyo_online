# Reserved test-admin lifecycle

The reserved admin is a real Supabase Auth user, pre-confirmed, using the same `/auth/login` page. It is not an unauthenticated backdoor. Display name `admin` does not grant the role; `app_accounts.role` does.

The operator supplied mailbox `2470034737@qq.com`. A real Auth user exists on `lzomhnjyymalupgvcato` (`64b61f8a-79d3-447a-9531-fb5deafd7527`), email pre-confirmed, `app_accounts.role=admin`, display name `admin`. The 智域 password stays in the operator secret store / process env only — never in git, docs, or logs. Do not rotate it unless Auth rejects it.

Do not auto-delete. The migration administrator is protected during storage
migration and must never be used as a deletion-test target.

## Official scripts (this lifecycle)

Scripts load gitignored `.env.hosted.local` if present. They never print the password.

`SUPABASE_SECRET_KEY` is **not** in `.env.hosted.local`. MCP `get_publishable_keys` returns publishable/anon only. Official **create** (`--apply`) and **delete** (`--apply`) still need the secret key.

Official **dry-run** works without the secret key: it signs in as this reserved admin (publishable key + operator password) and reads `reserved_admin_lifecycle_snapshot` (accounts v5). `--apply` is still refused when the mailbox already exists (no overwrite, no mis-promote).

`--apply` create accepts a password of **6+** characters (Supabase default). This user’s existing password was not changed.

```text
TEST_ADMIN_EMAIL=2470034737@qq.com pnpm accounts:provision-test-admin
```

Remove dry-run lists session ids that **would** be revoked and owned-row counts. It does not delete. Restart does not recreate the user.

This script is **not** called from Docker startup, migrations, ordinary traffic, or login failure.

## Isolation tests

Admin login alone is not isolation. Create two ordinary accounts A and B (at least one through real email confirmation once Resend SMTP exists). Admin must not read A/B private courses by id. A must not read B.

## Delete lifecycle proof (disposable account only)

Create a dedicated address containing `+delete-`, give it isolated test data,
and run the resumable deletion workflow against that exact address. Never copy
the long-lived administrator address into these commands.

```text
pnpm accounts:remove-test-admin -- --email=<disposable+delete-...>
CONFIRM_DELETE_ACCOUNT=YES pnpm accounts:remove-test-admin -- --email=<disposable+delete-...> --apply
```

`--apply` also requires the private database, Storage and Supabase Admin
credentials. The workflow first revokes application access and fences workers,
then removes relations and unreferenced objects, and only then removes Auth.
Failures remain in the deletion ledger for retry. The generic
`accounts:delete` command can delete a real account in a future, separately
approved operation; `MIGRATION_ADMIN_USER_ID` prevents accidental selection of
the current migration administrator.
