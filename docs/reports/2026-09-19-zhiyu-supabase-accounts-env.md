# Hosted accounts — environment configuration

Placeholders only. Never commit real passwords or secret keys.

Confirmed project: **zhiyu** ref `lzomhnjyymalupgvcato`, URL `https://lzomhnjyymalupgvcato.supabase.co`. This is **not** a production website cutover.

`zhiyulearn.online` is the planned production origin. It is **not** deployed and must not be used as Site URL / `APP_ORIGIN` until the site actually serves HTTPS there.

| Name | Browser | Current value / notes |
| --- | --- | --- |
| `AUTH_MODE` | no | Live `openmaic-main` stays **unset** so unsigned classroom stays anonymous. A real Supabase session still isolates that request (`user:{uuid}`) without flipping this flag. `supabase` still forces every request to be signed-in |
| `NEXT_PUBLIC_AUTH_MODE` | yes | must match `AUTH_MODE` (empty on the classroom stack) |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | `https://lzomhnjyymalupgvcato.supabase.co` — also in gitignored `.env.local` so confirm can exchange without flipping `AUTH_MODE` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | yes | placeholder in git. Dashboard key name `default`. Values only in gitignored `.env.hosted.local` / `.env.local` |
| `APP_ORIGIN` | no | **now** `http://localhost:3000` (compose publishes `3000:3000`). Later `https://zhiyulearn.online` |
| `DATABASE_URL_APP_WEB` | no | Operator LOGIN `zhiyu_app_web` via Session pooler (`zhiyu_app_web.<ref>` @ `aws-0-ap-southeast-1.pooler.supabase.com:5432`). Gitignored only. **Not** live generation-compose `DATABASE_URL` |
| `WORKER_DATABASE_URL` | no | LOGIN `zhiyu_app_worker` via the same Session pooler |
| `DATABASE_LISTEN_URL` | no | LISTEN; otherwise `WORKER_DATABASE_URL`. Transaction pooler (6543) is not for LISTEN |
| `HOSTED_DB_ADMIN_URL` | no | Privileged Session pooler `postgres.<ref>` URI in gitignored local only. Used to `ALTER ROLE`. Value not recorded |
| `GENERATION_MIGRATION_DATABASE_URL` | no | Optional alias for the same privileged URI / DDL |
| `SUPABASE_SECRET_KEY` | no | **absent** from `.env.hosted.local`. MCP has no secret-key tool. Needed only for official create/delete `--apply`. Role sync uses the user JWT + hosted `app_accounts` self-select instead |
| `TEST_ADMIN_EMAIL` / `TEST_ADMIN_PASSWORD` | no | email `2470034737@qq.com` and password live in gitignored `.env.hosted.local` only (values not recorded). Official `--apply` create accepts 6+ characters |
| `ASSET_BYTE_BACKEND=local` / `ASSET_LOCAL_ROOT` | no | Independent `openmaic-hosted` uses its private Docker asset volume; the live stack is unchanged |
| `GENERATION_TRUST_LEGACY_OWNER` | no | must stay off when hosted |

Resend SMTP is **Dashboard-only**. Do not put a Resend API key in the Next.js container. Users never register Resend and never give this app their QQ/163 mailbox password.

`ACCESS_CODE` is not an identity when a Supabase session is present. `PERSISTENCE_DEV_TOKEN` is not accepted as hosted auth for `user:{uuid}` owners. There is no `AUTH_BYPASS`.

Docker:

- Live stack (`openmaic-main`, bind `127.0.0.1:3000`, use **`http://localhost:3000`**) stays **`AUTH_MODE` unset** (zhiyu env present with length **0**; worker unset). Signed-in sessions isolate; unsigned traffic stays legacy. `scripts/generation-compose.ps1` never loads `docker-compose.hosted.yml`.
- Optional hosted UI: copy `.env.hosted.example` → `.env.hosted.local`, fill secrets, rebuild `docker-compose.hosted.yml` as compose project `openmaic-hosted` on **`127.0.0.1:3001`** (`APP_ORIGIN=http://localhost:3001`). Password grant only; do not change Dashboard Site URL (`http://localhost:3000`). Never combine with `docker-compose.persistence.yml`. Tear down with `docker compose -p openmaic-hosted down` when finished.
- `ASSET_BYTE_BACKEND` must stay unset on this classroom-media BYTEA compose.

Dashboard Auth URL steps and the later `https://zhiyulearn.online` switch: [zhiyu-resend-smtp.md](../guides/zhiyu-resend-smtp.md).

## LOGIN roles (hosted)

`app_web` / `app_worker` stay `NOLOGIN`. Inherit LOGIN roles exist on zhiyu:

- `zhiyu_app_web` — `LOGIN`, `INHERIT`, `NOBYPASSRLS`, member of `app_web`
- `zhiyu_app_worker` — same for `app_worker`

Operator Session pooler (Connect, session port **5432**): host `aws-0-ap-southeast-1.pooler.supabase.com`. Direct host `db.lzomhnjyymalupgvcato.supabase.co` still does not resolve on this workstation. Pooler usernames are `postgres.<ref>` (admin) and `zhiyu_app_web.<ref>` / `zhiyu_app_worker.<ref>` (LOGIN). Application pools explicitly require certificate verification; operator URL normalization uses `sslmode=verify-full`. Passwords live only in gitignored `.env.hosted.local`. Never commit or paste them.

`pnpm accounts:apply-hosted-logins` applied those LOGIN passwords and rewrote `DATABASE_URL_APP_WEB` / `WORKER_DATABASE_URL` to the Session pooler. Do not copy those URLs into live generation-compose `DATABASE_URL`. Transaction mode port `6543` is not for this LOGIN / GUC proof.

## Disposable local RLS proof (not the live stack)

`docker-compose.accounts-rls-proof.yml` is a throwaway Postgres on `127.0.0.1:55432`. `scripts/generation-compose.ps1` never loads it. After the local `app_web` proofs it was removed with `down -v`. Do not point this file at `openmaic-main_openmaic-postgres`.
